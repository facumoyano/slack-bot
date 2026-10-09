import bolt from "@slack/bolt";
import { handleMention, handleThreadReply } from "./bot.ts";
import type { BotDeps, Poster } from "./bot.ts";
import { parseCommand } from "./commands.ts";
import { findTarget, messageTexts, stripMention } from "./parse.ts";
import type { FoundTarget, KnownRepo } from "./parse.ts";
import { resolveWithClaude } from "./resolve.ts";

export type SlackConfig = { botToken: string; appToken: string; allowedUsers: ReadonlySet<string> };

export function createSlack(config: SlackConfig) {
  const app = new bolt.App({ token: config.botToken, appToken: config.appToken, socketMode: true });
  const poster: Poster = {
    async postToThread(job, text) {
      await app.client.chat.postMessage({ channel: job.slack.channel, thread_ts: job.slack.threadTs, text });
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

  const CONTEXT_LIMIT = 12000;

  async function start(deps: Omit<BotDeps, "poster" | "botUserId">): Promise<void> {
    const auth = await app.client.auth.test();
    const botUserId = auth.user_id as string;
    const botId = auth.bot_id as string | undefined;
    const full: BotDeps = { ...deps, poster, botUserId };

    app.event("app_mention", async ({ event }) => {
      if (!event.user || event.bot_id) return;
      const text = stripMention(event.text, botUserId);
      const command = parseCommand(text);
      if (command?.name === "aparte") return;
      const threadTs = event.thread_ts ?? event.ts;
      const where = { slack: { channel: event.channel, threadTs, requester: event.user } };
      if (!config.allowedUsers.has(event.user)) {
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
        // Newest first: a link posted later in the thread (often by another bot) beats the root.
        const thread: string[][] = [];
        if (event.thread_ts) {
          const replies = await app.client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 200 });
          for (const m of (replies.messages ?? []).filter((m) => m.ts !== event.ts && m.user !== botUserId && (!botId || m.bot_id !== botId)).reverse()) {
            thread.push(messageTexts(m as Parameters<typeof messageTexts>[0]).map((t) => stripMention(t, botUserId)));
          }
        }
        const ownTexts = messageTexts({ ...event, text: request });
        const all = [...ownTexts, ...thread.flat()];
        const repos = await deps.knownRepos().catch((err) => {
          console.error("listing known repos failed:", err);
          return [];
        });
        const ownTarget = findTarget(ownTexts, repos);
        // A separate task looks at the thread only through Claude, so an old link up-thread cannot claim it.
        const target: FoundTarget | undefined =
          (command?.name === "nuevo" ? ownTarget : findTarget(all, repos)) ??
          (await resolveWithClaude(all, repos).then(
            (t) => t && { ...t, source: "inferred" as const },
            (err) => {
              console.error("claude repo resolution failed:", err);
              return undefined;
            },
          ));
        const context = [...thread].reverse().map((t) => t[0] ?? "").filter(Boolean).join("\n---\n").slice(-CONTEXT_LIMIT);
        await handleMention(full, { ...mention, context: context || undefined, target, ownTarget });
      };
      work().catch(async (err) => {
        console.error("app_mention failed:", err);
        await poster.postToThread(where, `❌ algo falló: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      });
    });

    app.event("message", async ({ event }) => {
      const msg = event as { subtype?: string; bot_id?: string; user?: string; text?: string; thread_ts?: string; ts: string; channel: string };
      if (msg.subtype || msg.bot_id || !msg.user || !msg.thread_ts || msg.thread_ts === msg.ts) return;
      if (!config.allowedUsers.has(msg.user)) return;
      if (msg.text?.includes(`<@${botUserId}>`)) return;
      handleThreadReply(full, { channel: msg.channel, threadTs: msg.thread_ts, ts: msg.ts, text: msg.text ?? "" }).catch((err) =>
        console.error("thread reply failed:", err),
      );
    });

    await app.start();
    console.log(`slack: connected as ${botUserId}`);
  }

  return { poster, start };
}
