import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { answerQuestion } from "../src/ask.ts";
import { handleClick, handleMention, handleThreadReply } from "../src/bot.ts";
import { parseCommand } from "../src/commands.ts";
import type { BotDeps, Poster } from "../src/bot.ts";
import { parseClick } from "../src/blocks.ts";
import type { Block } from "../src/blocks.ts";
import { runInbox } from "../src/inbox.ts";
import { FILES_ROOT } from "../src/files.ts";
import { jobId } from "../src/jobs.ts";
import { ensureRun, findRepo, knownGithubRepos, realOrca, repoIdForPath } from "../src/orca.ts";
import { chooseTarget } from "../src/parse.ts";
import { latestSession } from "../src/session.ts";
import { openStore } from "../src/store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "repo-path": { type: "string" },
    state: { type: "string", default: "data/simulate-state.json" },
    "follow-up": { type: "string" },
    "cancel-after": { type: "string" },
  },
});
const request = positionals.join(" ").trim();
if (!request) {
  console.error('usage: node scripts/simulate.ts [--repo-path <orca repo path>] [--follow-up "<text>"] [--cancel-after <seconds>] "<request text or !command>"');
  process.exit(2);
}

const ts = () => new Date().toISOString().slice(11, 19);
let lastTs = 0;
const nextTs = () => (lastTs = Math.max(lastTs + 0.000001, Date.now() / 1000)).toFixed(6);
/** Which message each `:click <action> <value>` belongs to, as Slack would send it. */
const clickable = new Map<string, string>();

function showBlocks(messageTs: string, blocks: Block[] = []): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type !== "actions") continue;
    for (const el of block.elements) {
      if (el.type === "button" && el.url) lines.push(`  [${el.text.text}] → ${el.url}`);
      else if (el.type === "button" && el.value !== undefined) {
        clickable.set(`${el.action_id} ${el.value}`, messageTs);
        lines.push(`  [${el.text.text}] → :click ${el.action_id} ${el.value}`);
      } else if (el.type === "static_select") {
        lines.push(`  [${el.placeholder?.text ?? "elegir"}]`);
        for (const opt of el.options ?? []) {
          clickable.set(`${el.action_id} ${opt.value}`, messageTs);
          lines.push(`    ${opt.text.text} → :click ${el.action_id} ${opt.value}`);
        }
      }
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

const poster: Poster = {
  async postToThread(_job, text, blocks) {
    const messageTs = nextTs();
    console.log(`\n[${ts()}] [slack → hilo, ts ${messageTs}]\n${text}\n${showBlocks(messageTs, blocks)}`);
    return messageTs;
  },
  async update(_channel, messageTs, text, blocks) {
    console.log(`\n[${ts()}] [slack ✎ edita ${messageTs}]\n${text}\n${showBlocks(messageTs, blocks)}`);
  },
  async ephemeral(_job, user, text) {
    console.log(`[${ts()}] [slack efímero solo para ${user}] ${text}`);
  },
  async react(_channel, messageTs, name) {
    console.log(`[${ts()}] [slack reacción :${name}: en ${messageTs}]`);
  },
  async postTopLevel(_channel, text) {
    console.log(`\n[${ts()}] [slack → canal, hilo nuevo]\n${text}\n`);
    return (Date.now() / 1000).toFixed(6);
  },
  async uploadFile(_job, path) {
    console.log(`[${ts()}] [archivo] ${basename(path)} (${(await stat(path)).size} bytes)`);
  },
};

const command = parseCommand(request);
const text = command ? command.rest : request;
const repoPath = values["repo-path"] ? resolve(values["repo-path"]) : undefined;
const local = repoPath ? [{ owner: "local", name: basename(repoPath) }] : [];
const resolveRepo = (owner: string, name: string) =>
  repoPath && owner === "local" && name === basename(repoPath) ? repoIdForPath(repoPath) : findRepo(owner, name);
const knownRepos = async () => [...local, ...(await knownGithubRepos())];

const store = openStore(values.state!);
store.data.runId = await ensureRun(store.data.runId);
store.save();
console.log(`[${ts()}] run ${store.data.runId}`);

async function fetchFile(url: string): Promise<Response> {
  throw new Error(`the simulator cannot fetch ${url}`);
}

const deps: BotDeps = { orca: realOrca, poster, store, resolveRepo, knownRepos, allowedUsers: new Set(["USIM"]), latestSession, ask: answerQuestion, filesRoot: FILES_ROOT, fetchFile };
const channel = "SIM";
// The simulated thread has no other messages and no Claude fallback; --repo-path stands in for naming the repo.
const target =
  (await chooseTarget({ own: [text], thread: [], repos: await knownRepos(), channelRepo: store.data.channels[channel], infer: async () => undefined })) ??
  (local[0] && { ...local[0], source: "link" as const });
const threadTs = (Date.now() / 1000).toFixed(6);
const id = jobId(channel, threadTs);
const finished = () => {
  const kind = store.data.jobs[id]?.state.kind;
  return kind === "done" || kind === "failed" || kind === "cancelled";
};

console.log(`[${ts()}] [usuario USIM] @bot ${request}`);
if (command?.name === "pregunta" || command?.name === "repo") {
  await handleMention(deps, { channel, threadTs, ts: threadTs, user: "USIM", text, command: command.name, target });
  console.log(`[${ts()}] jobs en el hilo: ${store.data.jobs[id] ? "1" : "0"}`);
  process.exit(0);
}
const stdin = createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  const click = /^:click(?:-as\s+(\S+))?\s+(\S+)\s+(.+)$/.exec(text);
  if (click) {
    const [, as = "USIM", action, value] = click;
    const messageTs = clickable.get(`${action} ${value}`);
    const parsed = parseClick(action, value);
    if (!parsed || !messageTs) return console.log(`[${ts()}] (click desconocido: ${action} ${value})`);
    console.log(`[${ts()}] [usuario ${as} toca ${action} en ${messageTs}]`);
    handleClick(deps, { click: parsed, user: as, channel, threadTs, messageTs }).catch((err) => console.error("click failed:", err));
    return;
  }
  console.log(`[${ts()}] [usuario USIM responde en hilo] ${text}`);
  handleThreadReply(deps, { channel, threadTs, ts: nextTs(), user: "USIM", text })
    .then((handled) => handled || console.log(`[${ts()}] (sin job activo en el hilo; ignorado)`))
    .catch((err) => console.error("thread reply failed:", err));
});

const inboxDeps = { orca: realOrca, poster, store, latestSession };
const inbox = runInbox(inboxDeps, finished);
const cancelAfter = Number(values["cancel-after"] ?? 0) * 1000;
if (cancelAfter) {
  const waitForWorker = setInterval(() => {
    if (store.data.jobs[id]?.state.kind !== "working") return;
    clearInterval(waitForWorker);
    setTimeout(() => {
      console.log(`[${ts()}] [usuario USIM menciona en el hilo] @bot !parar`);
      handleMention(deps, { channel, threadTs, ts: (Date.now() / 1000).toFixed(6), user: "USIM", text: "", command: "parar" }).catch((err) =>
        console.error("cancel failed:", err),
      );
    }, cancelAfter);
  }, 500);
}
await handleMention(deps, { channel, threadTs, ts: threadTs, user: "USIM", text, command: command?.name, target });
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
process.exit(["done", "cancelled"].includes(store.data.jobs[id].state.kind) ? 0 : 1);
