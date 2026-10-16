import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import bolt from "@slack/bolt";
import { listUsers } from "../src/slack.ts";
import { USAGE, UsageError, parseCommand, run, threadForCwd } from "../src/thread.ts";
import type { Channel, SlackApi, StateJob, Thread, ThreadMsg } from "../src/thread.ts";

const STATE = join(import.meta.dirname, "..", "data", "state.json");

function gitToplevel(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function findThread(statePath = STATE): Promise<Thread> {
  const raw = await readFile(statePath, "utf8").catch(() => {
    throw new UsageError(`no pude leer el estado de Alfred en ${statePath}; pasá --thread <canal>:<ts>`);
  });
  const jobs = (JSON.parse(raw) as { jobs?: Record<string, StateJob> }).jobs ?? {};
  return threadForCwd(jobs, gitToplevel(), process.cwd());
}

function slackApi(token: string): SlackApi {
  const client = new bolt.webApi.WebClient(token);
  let self: ReturnType<SlackApi["self"]> | undefined;
  return {
    self: () =>
      (self ??= client.auth.test().then((auth) => ({ userId: auth.user_id as string, botId: auth.bot_id as string | undefined }))),
    users: () => listUsers(client),
    async replies(thread) {
      const messages: ThreadMsg[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.conversations.replies({ channel: thread.channel, ts: thread.threadTs, limit: 200, cursor });
        for (const m of page.messages ?? []) {
          if (!m.ts) continue;
          messages.push({
            ts: m.ts,
            user: m.user,
            botId: m.bot_id,
            username: m.username ?? m.bot_profile?.name,
            text: m.text ?? "",
            files: (m.files ?? []).map((f) => f.name ?? f.title ?? f.id ?? "archivo"),
          });
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return messages;
    },
    async post(place, message) {
      const res = await client.chat.postMessage({ channel: place.channel, thread_ts: place.threadTs, text: message.text, blocks: message.blocks });
      if (!res.ts) throw new Error("chat.postMessage no devolvió ts");
      return res.ts;
    },
    async permalink(channel, ts) {
      const res = await client.chat.getPermalink({ channel, message_ts: ts });
      return res.permalink ?? "(sin permalink)";
    },
    async upload(place, path) {
      await client.filesUploadV2({ channel_id: place.channel, thread_ts: place.threadTs, file: path, filename: basename(path) });
    },
    async channels() {
      const channels: Channel[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.conversations.list({ types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
        for (const c of page.channels ?? []) if (c.id && c.name) channels.push({ id: c.id, name: c.name });
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return channels;
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return argv.length ? 0 : 1;
  }
  const cmd = parseCommand(argv);
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) throw new UsageError("falta SLACK_BOT_TOKEN: corré con node --env-file=/home/facu/orca/projects/slack-bot/.env");
  return run(cmd, {
    api: slackApi(token),
    findThread,
    clock: { now: () => Date.now(), sleep: (ms) => sleep(ms) },
    out: (line) => console.log(line),
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError) console.error(`error: ${err.message}\n\n${USAGE}`);
    else console.error(err?.data?.error ? `error de Slack: ${err.data.error}` : `error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
