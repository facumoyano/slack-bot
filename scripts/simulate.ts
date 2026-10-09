import { createInterface } from "node:readline";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { handleMention, handleThreadReply } from "../src/bot.ts";
import type { BotDeps, Poster } from "../src/bot.ts";
import { runInbox } from "../src/inbox.ts";
import { jobId } from "../src/jobs.ts";
import { ensureRun, findRepo, realOrca, repoIdForPath } from "../src/orca.ts";
import { parseTarget } from "../src/parse.ts";
import { latestSession } from "../src/session.ts";
import { openStore } from "../src/store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "repo-path": { type: "string" },
    state: { type: "string", default: "data/simulate-state.json" },
    "follow-up": { type: "string" },
  },
});
const request = positionals.join(" ").trim();
if (!request) {
  console.error('usage: node scripts/simulate.ts [--repo-path <orca repo path>] [--follow-up "<text>"] "<request text>"');
  process.exit(2);
}

const ts = () => new Date().toISOString().slice(11, 19);
const poster: Poster = {
  async postToThread(_job, text) {
    console.log(`\n[${ts()}] [slack → hilo]\n${text}\n`);
  },
  async react(_channel, messageTs, name) {
    console.log(`[${ts()}] [slack reacción :${name}: en ${messageTs}]`);
  },
  async postTopLevel(_channel, text) {
    console.log(`\n[${ts()}] [slack → canal, hilo nuevo]\n${text}\n`);
    return (Date.now() / 1000).toFixed(6);
  },
};

const repoPath = values["repo-path"] ? resolve(values["repo-path"]) : undefined;
const parsed = repoPath ? { owner: "local", name: basename(repoPath) } : parseTarget([request]);
const target = parsed && { ...parsed, source: "link" as const };
const resolveRepo = repoPath ? () => repoIdForPath(repoPath) : findRepo;

const store = openStore(values.state!);
store.data.runId = await ensureRun(store.data.runId);
store.save();
console.log(`[${ts()}] run ${store.data.runId}`);

const deps: BotDeps = { orca: realOrca, poster, store, resolveRepo };
const channel = "SIM";
const threadTs = (Date.now() / 1000).toFixed(6);
const id = jobId(channel, threadTs);
const finished = () => {
  const kind = store.data.jobs[id]?.state.kind;
  return kind === "done" || kind === "failed";
};

console.log(`[${ts()}] [usuario USIM] @bot ${request}`);
const stdin = createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  console.log(`[${ts()}] [usuario USIM responde en hilo] ${text}`);
  handleThreadReply(deps, { channel, threadTs, ts: (Date.now() / 1000).toFixed(6), text })
    .then((handled) => handled || console.log(`[${ts()}] (sin job activo en el hilo; ignorado)`))
    .catch((err) => console.error("thread reply failed:", err));
});

const inboxDeps = { orca: realOrca, poster, store, latestSession };
const inbox = runInbox(inboxDeps, finished);
await handleMention(deps, { channel, threadTs, ts: threadTs, user: "USIM", text: request, target });
if (!store.data.jobs[id]) process.exit(1);
await inbox;

const followUp = values["follow-up"]?.trim();
if (followUp && store.data.jobs[id].state.kind === "done") {
  console.log(`[${ts()}] estado intermedio: ${JSON.stringify(store.data.jobs[id])}`);
  console.log(`[${ts()}] [usuario USIM menciona en el hilo] @bot ${followUp}`);
  // The job is still done until the mention lands, and runInbox would stop at once on a finished job.
  await handleMention(deps, { channel, threadTs, ts: (Date.now() / 1000).toFixed(6), user: "USIM", text: followUp });
  await runInbox(inboxDeps, finished);
}
console.log(`[${ts()}] estado final: ${JSON.stringify(store.data.jobs[id])}`);
stdin.close();
process.exit(store.data.jobs[id].state.kind === "done" ? 0 : 1);
