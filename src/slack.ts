import { basename } from "node:path";
import bolt from "@slack/bolt";
import { ACTION_PREFIX, parseClick } from "./blocks.ts";
import { accessOf, handleClick, handleDm, handleMention, handleThreadReply } from "./bot.ts";
import type { BotDeps, Poster } from "./bot.ts";
import { parseCommand } from "./commands.ts";
import { messageFiles } from "./files.ts";
import { chooseTarget, findTarget, messageTexts, stripMention } from "./parse.ts";
import { resolveWithClaude } from "./resolve.ts";
import type { SlackUser } from "./thread.ts";

export type SlackConfig = { botToken: string; appToken: string };

const CONTEXT_LIMIT = 12000;

/** An earlier human message of the thread: its visible texts and its Slack file objects. */
type ThreadMessage = { texts: string[]; files?: unknown[] };

/** The thread's earlier human messages as the worker's context, oldest first. */
function contextOf(thread: readonly ThreadMessage[]): string | undefined {
  return [...thread].reverse().map((t) => t.texts[0] ?? "").filter(Boolean).join("\n---\n").slice(-CONTEXT_LIMIT) || undefined;
}

/**
 * Every Block Kit click goes through one handler: ack first (URL buttons included, or Slack shows an error),
 * then parse and validate the value, then the same paths as typed input.
 */
export function registerActions(app: bolt.App, deps: BotDeps, readThread: (channel: string, threadTs: string) => Promise<ThreadMessage[]>): void {
  app.action(new RegExp(`^${ACTION_PREFIX}`), async ({ ack, body, action }) => {
    await ack();
    if (body.type !== "block_actions") return;
    const value = action.type === "static_select" ? action.selected_option?.value : action.type === "button" ? action.value : undefined;
    const click = parseClick(action.action_id, value);
    const channel = body.channel?.id;
    const messageTs = body.message?.ts ?? body.container?.message_ts;
    if (!click || !channel || !messageTs) return;
    const threadTs = (body.message?.thread_ts as string | undefined) ?? messageTs;
    const work = async () => {
      const thread = click.kind === "repo" ? await readThread(channel, threadTs).catch(() => []) : [];
      await handleClick(deps, { click, user: body.user.id, channel, threadTs, messageTs, context: contextOf(thread), files: messageFiles(thread) });
    };
    work().catch((err) => console.error(`click ${action.action_id} failed:`, err));
  });
}

/**
 * Direct messages are owners' private instructions. Plain thread replies, a file upload included, reach their thread's job;
 * anyone's, since a relay may wait on someone with no access, and the job decides whose counts.
 */
export function registerMessages(app: bolt.App, deps: BotDeps, botUserId: string): void {
  app.event("message", async ({ event }) => {
    const msg = event as {
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      thread_ts?: string;
      ts: string;
      channel: string;
      channel_type?: string;
      files?: unknown[];
    };
    if ((msg.subtype && msg.subtype !== "file_share") || msg.bot_id || !msg.user) return;
    if (msg.channel_type === "im") {
      handleDm(deps, { user: msg.user, text: msg.text ?? "" }).catch((err) => console.error("direct message failed:", err));
      return;
    }
    if (!msg.thread_ts || msg.thread_ts === msg.ts) return;
    if (msg.text?.includes(`<@${botUserId}>`)) return;
    handleThreadReply(deps, { channel: msg.channel, threadTs: msg.thread_ts, ts: msg.ts, user: msg.user, text: msg.text ?? "", files: msg.files }).catch((err) =>
      console.error("thread reply failed:", err),
    );
  });
}

/** Mentions from people, never bots: a stranger is refused at once, anyone else's is resolved against the thread first. */
export function registerMentions(app: bolt.App, deps: BotDeps, readThread: (channel: string, threadTs: string, exceptTs?: string) => Promise<ThreadMessage[]>): void {
  app.event("app_mention", async ({ event }) => {
    if (!event.user || event.bot_id) return;
    const text = stripMention(event.text, deps.botUserId ?? "");
    const command = parseCommand(text);
    if (command?.name === "aparte") return;
    const threadTs = event.thread_ts ?? event.ts;
    const where = { slack: { channel: event.channel, threadTs, requester: event.user } };
    const request = command ? command.rest : text;
    const mention = { channel: event.channel, threadTs, ts: event.ts, user: event.user, text: request, command: command?.name };
    const work = async () => {
      const quick = command?.name === "parar" || command?.name === "ayuda" || command?.name === "repo";
      if (quick || accessOf(deps, mention.user) === "stranger") return handleMention(deps, mention);
      const thread = event.thread_ts ? await readThread(event.channel, event.thread_ts, event.ts) : [];
      const ownTexts = messageTexts({ ...event, text: request });
      const threadTexts = thread.flatMap((m) => m.texts);
      const all = [...ownTexts, ...threadTexts];
      const repos = await deps.knownRepos().catch((err) => {
        console.error("listing known repos failed:", err);
        return [];
      });
      const ownTarget = findTarget(ownTexts, repos);
      const target = await chooseTarget({
        own: ownTexts,
        thread: threadTexts,
        repos,
        channelRepo: deps.store.data.channels[event.channel],
        separate: command?.name === "nuevo",
        infer: () =>
          resolveWithClaude(all, repos).catch((err) => {
            console.error("claude repo resolution failed:", err);
            return undefined;
          }),
      });
      const files = messageFiles([event as { files?: unknown }, ...thread]);
      await handleMention(deps, { ...mention, context: contextOf(thread), target, ownTarget, files });
    };
    work().catch(async (err) => {
      console.error("app_mention failed:", err);
      await deps.poster.postToThread(where, `❌ algo falló: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
  });
}

export async function listUsers(client: bolt.webApi.WebClient): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.users.list({ limit: 200, cursor });
    for (const u of page.members ?? []) {
      if (!u.id) continue;
      users.push({
        id: u.id,
        name: u.name ?? "",
        displayName: u.profile?.display_name ?? "",
        realName: u.real_name ?? u.profile?.real_name ?? "",
        isBot: !!u.is_bot || u.id === "USLACKBOT",
        deleted: !!u.deleted,
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return users;
}

export function createSlack(config: SlackConfig) {
  const app = new bolt.App({ token: config.botToken, appToken: config.appToken, socketMode: true });
  const poster: Poster = {
    async postToThread(job, text, blocks) {
      const res = await app.client.chat.postMessage({ channel: job.slack.channel, thread_ts: job.slack.threadTs, text, blocks });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return res.ts;
    },
    async update(channel, ts, text, blocks) {
      await app.client.chat.update({ channel, ts, text, blocks });
    },
    async ephemeral(job, user, text) {
      await app.client.chat.postEphemeral({ channel: job.slack.channel, thread_ts: job.slack.threadTs, user, text });
    },
    async react(channel, messageTs, name) {
      await app.client.reactions.add({ channel, timestamp: messageTs, name }).catch((err) => {
        if (err?.data?.error !== "already_reacted") throw err;
      });
    },
    async postTopLevel(channel, text) {
      const res = await app.client.chat.postMessage({ channel, text });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return res.ts;
    },
    async uploadFile(job, path) {
      await app.client.filesUploadV2({ channel_id: job.slack.channel, thread_ts: job.slack.threadTs, file: path, filename: basename(path) });
    },
    async permalink(channel, ts) {
      const res = await app.client.chat.getPermalink({ channel, message_ts: ts });
      if (!res.permalink) throw new Error("chat.getPermalink returned no permalink");
      return res.permalink;
    },
    async dm(user, text, blocks) {
      const open = await app.client.conversations.open({ users: user });
      const channel = open.channel?.id;
      if (!channel) throw new Error("conversations.open returned no channel");
      const res = await app.client.chat.postMessage({ channel, text, blocks });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return { channel, ts: res.ts };
    },
  };
  const fetchFile = (url: string) => fetch(url, { headers: { Authorization: `Bearer ${config.botToken}` } });

  async function start(deps: Omit<BotDeps, "poster" | "botUserId" | "fetchFile" | "users">): Promise<void> {
    const auth = await app.client.auth.test();
    const botUserId = auth.user_id as string;
    const botId = auth.bot_id as string | undefined;
    const full: BotDeps = { ...deps, poster, botUserId, fetchFile, users: () => listUsers(app.client) };

    /** Each earlier human message, newest first: a link posted later (often by another bot) beats the root. */
    async function readThread(channel: string, threadTs: string, exceptTs?: string): Promise<ThreadMessage[]> {
      const replies = await app.client.conversations.replies({ channel, ts: threadTs, limit: 200 });
      return (replies.messages ?? [])
        .filter((m) => m.ts !== exceptTs && m.user !== botUserId && (!botId || m.bot_id !== botId))
        .reverse()
        .map((m) => ({
          texts: messageTexts(m as Parameters<typeof messageTexts>[0]).map((t) => stripMention(t, botUserId)),
          files: m.files,
        }));
    }

    registerMentions(app, full, readThread);
    registerMessages(app, full, botUserId);
    registerActions(app, full, (channel, threadTs) => readThread(channel, threadTs));

    await app.start();
    console.log(`slack: connected as ${botUserId}`);
  }

  return { poster, start };
}
