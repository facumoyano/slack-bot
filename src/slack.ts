import bolt from "@slack/bolt";
import { handleMention, handleThreadReply } from "./bot.ts";
import type { BotDeps, Poster } from "./bot.ts";
import { messageTexts, parseTarget, stripMention } from "./parse.ts";

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
  };

  async function start(deps: Omit<BotDeps, "poster">): Promise<void> {
    const botUserId = (await app.client.auth.test()).user_id as string;
    const full: BotDeps = { ...deps, poster };

    app.event("app_mention", async ({ event }) => {
      if (!event.user || event.bot_id) return;
      const threadTs = event.thread_ts ?? event.ts;
      const where = { slack: { channel: event.channel, threadTs, requester: event.user } };
      if (!config.allowedUsers.has(event.user)) {
        await poster.postToThread(
          where,
          `Perdón <@${event.user}>, no tengo permiso para trabajar para vos. Pedile al dueño del bot que agregue tu ID \`${event.user}\` a ALLOWED_SLACK_USERS.`,
        );
        return;
      }
      const text = stripMention(event.text, botUserId);
      const work = async () => {
        let rootTexts: string[] = [];
        if (event.thread_ts) {
          const replies = await app.client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 1 });
          const root = replies.messages?.[0];
          if (root) rootTexts = messageTexts(root as Parameters<typeof messageTexts>[0]);
        }
        const ownTexts = messageTexts({ ...event, text });
        await handleMention(full, {
          channel: event.channel,
          threadTs,
          ts: event.ts,
          user: event.user!,
          text,
          context: rootTexts.length ? rootTexts.join("\n") : undefined,
          target: parseTarget([...ownTexts, ...rootTexts]),
        });
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
