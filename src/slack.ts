import bolt from "@slack/bolt";
import { ACTION_PREFIX, parseClick } from "./blocks.ts";
import { handleClick, handleMention, handleThreadReply } from "./bot.ts";
import type { BotDeps, Poster } from "./bot.ts";
import { parseCommand } from "./commands.ts";
import { chooseTarget, findTarget, messageTexts, stripMention } from "./parse.ts";
import { resolveWithClaude } from "./resolve.ts";

export type SlackConfig = { botToken: string; appToken: string };

const CONTEXT_LIMIT = 12000;

/** The thread's earlier human messages as the worker's context, oldest first. */
function contextOf(thread: readonly string[][]): string | undefined {
  return [...thread].reverse().map((t) => t[0] ?? "").filter(Boolean).join("\n---\n").slice(-CONTEXT_LIMIT) || undefined;
}

/**
 * Every Block Kit click goes through one handler: ack first (URL buttons included, or Slack shows an error),
 * then parse and validate the value, then the same paths as typed input.
 */
export function registerActions(app: bolt.App, deps: BotDeps, readContext: (channel: string, threadTs: string) => Promise<string | undefined>): void {
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
      const context = click.kind === "repo" ? await readContext(channel, threadTs).catch(() => undefined) : undefined;
      await handleClick(deps, { click, user: body.user.id, channel, threadTs, messageTs, context });
    };
    work().catch((err) => console.error(`click ${action.action_id} failed:`, err));
  });
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
  };

  async function start(deps: Omit<BotDeps, "poster" | "botUserId">): Promise<void> {
    const auth = await app.client.auth.test();
    const botUserId = auth.user_id as string;
    const botId = auth.bot_id as string | undefined;
    const full: BotDeps = { ...deps, poster, botUserId };

    /** Each earlier human message's texts, newest first: a link posted later (often by another bot) beats the root. */
    async function readThread(channel: string, threadTs: string, exceptTs?: string): Promise<string[][]> {
      const replies = await app.client.conversations.replies({ channel, ts: threadTs, limit: 200 });
      return (replies.messages ?? [])
        .filter((m) => m.ts !== exceptTs && m.user !== botUserId && (!botId || m.bot_id !== botId))
        .reverse()
        .map((m) => messageTexts(m as Parameters<typeof messageTexts>[0]).map((t) => stripMention(t, botUserId)));
    }

    app.event("app_mention", async ({ event }) => {
      if (!event.user || event.bot_id) return;
      const text = stripMention(event.text, botUserId);
      const command = parseCommand(text);
      if (command?.name === "aparte") return;
      const threadTs = event.thread_ts ?? event.ts;
      const where = { slack: { channel: event.channel, threadTs, requester: event.user } };
      if (!deps.allowedUsers.has(event.user)) {
        await poster.postToThread(
          where,
          `Perdón <@${event.user}>, no tengo permiso para trabajar para vos. Pedile al dueño del bot que agregue tu ID \`${event.user}\` a ALLOWED_SLACK_USERS.`,
        );
        return;
      }
      const request = command ? command.rest : text;
      const mention = { channel: event.channel, threadTs, ts: event.ts, user: event.user, text: request, command: command?.name };
      const work = async () => {
        if (command?.name === "parar" || command?.name === "ayuda" || command?.name === "repo") return handleMention(full, mention);
        const thread = event.thread_ts ? await readThread(event.channel, event.thread_ts, event.ts) : [];
        const ownTexts = messageTexts({ ...event, text: request });
        const all = [...ownTexts, ...thread.flat()];
        const repos = await deps.knownRepos().catch((err) => {
          console.error("listing known repos failed:", err);
          return [];
        });
        const ownTarget = findTarget(ownTexts, repos);
        const target = await chooseTarget({
          own: ownTexts,
          thread: thread.flat(),
          repos,
          channelRepo: deps.store.data.channels[event.channel],
          separate: command?.name === "nuevo",
          infer: () =>
            resolveWithClaude(all, repos).catch((err) => {
              console.error("claude repo resolution failed:", err);
              return undefined;
            }),
        });
        await handleMention(full, { ...mention, context: contextOf(thread), target, ownTarget });
      };
      work().catch(async (err) => {
        console.error("app_mention failed:", err);
        await poster.postToThread(where, `❌ algo falló: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      });
    });

    app.event("message", async ({ event }) => {
      const msg = event as { subtype?: string; bot_id?: string; user?: string; text?: string; thread_ts?: string; ts: string; channel: string };
      if (msg.subtype || msg.bot_id || !msg.user || !msg.thread_ts || msg.thread_ts === msg.ts) return;
      if (!deps.allowedUsers.has(msg.user)) return;
      if (msg.text?.includes(`<@${botUserId}>`)) return;
      handleThreadReply(full, { channel: msg.channel, threadTs: msg.thread_ts, ts: msg.ts, user: msg.user, text: msg.text ?? "" }).catch((err) =>
        console.error("thread reply failed:", err),
      );
    });

    registerActions(app, full, async (channel, threadTs) => contextOf(await readThread(channel, threadTs)));

    await app.start();
    console.log(`slack: connected as ${botUserId}`);
  }

  return { poster, start };
}
