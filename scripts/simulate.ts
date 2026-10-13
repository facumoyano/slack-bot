import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { answerQuestion } from "../src/ask.ts";
import { handleClick, handleDm, handleMention, handleThreadReply } from "../src/bot.ts";
import { parseCommand } from "../src/commands.ts";
import type { BotDeps, Poster } from "../src/bot.ts";
import { parseClick } from "../src/blocks.ts";
import type { Block } from "../src/blocks.ts";
import { runInbox } from "../src/inbox.ts";
import { FILES_ROOT } from "../src/files.ts";
import { jobId } from "../src/jobs.ts";
import { ensureRun, findRepo, knownGithubRepos, realOrca, repoIdForPath } from "../src/orca.ts";
import { chooseTarget } from "../src/parse.ts";
import { classifyWithJev } from "../src/route.ts";
import { latestSession } from "../src/session.ts";
import { openStore } from "../src/store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "repo-path": { type: "string" },
    state: { type: "string", default: "data/simulate-state.json" },
    "follow-up": { type: "string" },
    "cancel-after": { type: "string" },
    attach: { type: "string", multiple: true },
    as: { type: "string", default: "USIM" },
    teammates: { type: "string", default: "UTEAM" },
    dm: { type: "string", multiple: true },
    "reply-as": { type: "string", default: "USALVA" },
    reply: { type: "string" },
    users: { type: "string", default: "USALVA=salva,USEBAS=sebas" },
  },
});
const request = positionals.join(" ").trim();
if (!request) {
  console.error(
    'usage: node scripts/simulate.ts [--repo-path <orca repo path>] [--as <userId>] [--teammates <ids>] [--follow-up "<text>"] [--cancel-after <seconds>] [--attach <file>]... [--dm "<owner DM>"]... [--reply-as <userId>] [--reply "<text>"] [--users <id=name,…>] "<request text or !command>"',
  );
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
  async permalink(channel, messageTs) {
    const link = `https://slack.example/archives/${channel}/p${messageTs.replace(".", "")}`;
    console.log(`[${ts()}] [slack permalink de ${channel}/${messageTs}] ${link}`);
    return link;
  },
  async dm(user, text, blocks) {
    const messageTs = nextTs();
    console.log(`\n[${ts()}] [slack → DM a ${user}, ts ${messageTs}]\n${text}\n${showBlocks(messageTs, blocks)}`);
    return { channel: `DSIM-${user}`, ts: messageTs };
  },
};

/** USIM is the owner; `--as` mentions and replies as someone else, a teammate when listed in `--teammates`. */
const OWNER = "USIM";
const user = values.as!;
const teammates = new Set(values.teammates!.split(",").map((s) => s.trim()).filter(Boolean));

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

const MIMETYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".md": "text/markdown" };

/** Local files as the Slack file objects of the request message, served from disk instead of Slack. */
const attached = (values.attach ?? []).map((path, i) => {
  const abs = resolve(path);
  return { id: `FSIM${i + 1}`, name: basename(abs), mimetype: MIMETYPES[extname(abs).toLowerCase()] ?? "application/octet-stream", url_private_download: pathToFileURL(abs).href };
});

async function fetchFile(url: string): Promise<Response> {
  return new Response(await readFile(fileURLToPath(url)));
}

const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
console.log(`[${ts()}] ruteo de menciones sin comando: ${typesafeKey ? "Jev" : "apagado (sin TYPESAFE_API_KEY), son cambios"}`);
const classify = typesafeKey
  ? async (state: Parameters<typeof classifyWithJev>[1]) => {
      const answer = await classifyWithJev(typesafeKey, state);
      console.log(`[${ts()}] [jev] ${answer.choice} @ ${answer.confidence.toFixed(2)} ${JSON.stringify(answer.probabilities)}`);
      return answer;
    }
  : undefined;

/** The fake workspace an owner's DM names people from. */
const people = [`${OWNER}=owner`, ...values.users!.split(",")].map((pair) => {
  const [id, name] = pair.split("=").map((x) => x.trim());
  return { id, name, displayName: name, realName: name, isBot: false, deleted: false };
});
const users = async () => people;

const deps: BotDeps = { orca: realOrca, poster, store, resolveRepo, knownRepos, allowedUsers: new Set([OWNER]), approvalUsers: teammates, latestSession, ask: answerQuestion, filesRoot: FILES_ROOT, fetchFile, classify, users };
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

const pendingApproval = () => Object.values(store.data.approvals).some((a) => a.state.kind === "pending" && a.mention.threadTs === threadTs);

console.log(`[${ts()}] [usuario ${user}] @bot ${request}`);
/** The latest click's work, so the run waits for a picked route to finish starting. */
let clickWork: Promise<void> = Promise.resolve();
const stdin = createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  const click = /^:click(?:-as\s+(\S+))?\s+(\S+)\s+(.+)$/.exec(text);
  if (click) {
    const [, as = OWNER, action, value] = click;
    const messageTs = clickable.get(`${action} ${value}`);
    const parsed = parseClick(action, value);
    if (!parsed || !messageTs) return console.log(`[${ts()}] (click desconocido: ${action} ${value})`);
    console.log(`[${ts()}] [usuario ${as} toca ${action} en ${messageTs}]`);
    clickWork = handleClick(deps, { click: parsed, user: as, channel, threadTs, messageTs }).catch((err) => console.error("click failed:", err));
    return;
  }
  console.log(`[${ts()}] [usuario ${user} responde en hilo] ${text}`);
  handleThreadReply(deps, { channel, threadTs, ts: nextTs(), user, text })
    .then((handled) => handled || console.log(`[${ts()}] (sin job activo en el hilo; ignorado)`))
    .catch((err) => console.error("thread reply failed:", err));
});

const inboxDeps = { orca: realOrca, poster, store, latestSession, filesRoot: FILES_ROOT };
const inbox = runInbox(inboxDeps, finished);
const cancelAfter = Number(values["cancel-after"] ?? 0) * 1000;
if (cancelAfter) {
  const waitForWorker = setInterval(() => {
    if (store.data.jobs[id]?.state.kind !== "working") return;
    clearInterval(waitForWorker);
    setTimeout(() => {
      console.log(`[${ts()}] [usuario ${user} menciona en el hilo] @bot !parar`);
      handleMention(deps, { channel, threadTs, ts: (Date.now() / 1000).toFixed(6), user, text: "", command: "parar" }).catch((err) =>
        console.error("cancel failed:", err),
      );
    }, cancelAfter);
  }, 500);
}

/** A picked route can lead to an approval, so wait until neither is pending and the last click's work is done. */
async function waitForClicks(): Promise<void> {
  for (;;) {
    await clickWork;
    if (!store.data.pendingRoutes[id] && !pendingApproval()) return;
    console.log(`[${ts()}] (esperando ${pendingApproval() ? "la aprobación" : "que elijas una opción"}: pegá una línea :click …)`);
    while (store.data.pendingRoutes[id] || pendingApproval()) await new Promise((r) => setTimeout(r, 200));
  }
}

await handleMention(deps, { channel, threadTs, ts: threadTs, user, text, command: command?.name, target, files: attached });
if (!store.data.jobs[id]) await waitForClicks();
if (!store.data.jobs[id]) {
  // Answered, reacted to, or refused: nothing runs in the background.
  console.log(`[${ts()}] jobs en el hilo: 0`);
  process.exit(0);
}
await inbox;

const followUp = values["follow-up"]?.trim();
if (followUp && store.data.jobs[id].state.kind === "done") {
  console.log(`[${ts()}] estado intermedio: ${JSON.stringify(store.data.jobs[id])}`);
  console.log(`[${ts()}] [usuario ${user} menciona en el hilo] @bot ${followUp}`);
  const followUpCommand = parseCommand(followUp);
  // The job is still done until the mention lands, and runInbox would stop at once on a finished job.
  await handleMention(deps, { channel, threadTs, ts: (Date.now() / 1000).toFixed(6), user, text: followUpCommand?.rest ?? followUp, command: followUpCommand?.name });
  await waitForClicks();
  await runInbox(inboxDeps, finished);
}
const dms = (values.dm ?? []).map((d) => d.trim()).filter(Boolean);
const kind = () => store.data.jobs[id].state.kind;
const relaying = () => kind() === "relaying";
for (const [i, dm] of dms.entries()) {
  if (kind() !== "done") break;
  // Only the first DM carries the thread's link; the rest continue the owner's last thread.
  const text = i === 0 ? `<${await poster.permalink(channel, threadTs)}> ${dm}` : dm;
  console.log(`[${ts()}] [usuario ${OWNER} → DM al bot] ${text}`);
  await handleDm(deps, { user: OWNER, text });
  await runInbox(inboxDeps, () => !relaying());
  const reply = values.reply?.trim();
  if (reply && kind() === "awaiting_reply") {
    const replier = values["reply-as"]!;
    console.log(`[${ts()}] [usuario ${replier} responde en hilo] ${reply}`);
    await handleThreadReply(deps, { channel, threadTs, ts: nextTs(), user: replier, text: reply });
    await runInbox(inboxDeps, () => !relaying());
  }
}
console.log(`[${ts()}] estado final: ${JSON.stringify(store.data.jobs[id])}`);
stdin.close();
process.exit(["done", "cancelled", "awaiting_reply"].includes(store.data.jobs[id].state.kind) ? 0 : 1);
