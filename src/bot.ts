import { approvalId, decide, dueExpiries } from "./approvals.ts";
import type { Approval, Decision, Work } from "./approvals.ts";
import { antecedentsPost, earlierWork, findAntecedents } from "./antecedents.ts";
import type { EarlierWork } from "./antecedents.ts";
import { ROUTE_QUESTION, answeredMessage, approvalCard, plainMessage, routeAskMessage, startMessage } from "./blocks.ts";
import type { Block, Click } from "./blocks.ts";
import { commandMode, helpText, parseCommand, parseRepoArg } from "./commands.ts";
import type { CommandName } from "./commands.ts";
import { mkdir } from "node:fs/promises";
import { downloadFiles, inboxDir, jobSlug, outboxDir, problemsNotice, selectFiles, shownText, withFiles } from "./files.ts";
import type { LocalFile } from "./files.ts";
import { PLAN_OPTIONS, activeJobInDir, awaitsReply, dueRelayExpiries, isActive, isOtherTask, isResumable, jobId, jobLabel, lastRun, newJob, sameRepo, targetLabel, transition } from "./jobs.ts";
import type { Job, JobEvent, LocalDir, Mode, Person, RepoRef } from "./jobs.ts";
import { worktreePath, worktreeSelector } from "./orca.ts";
import type { Orca, WorkerStart } from "./orca.ts";
import { pullTarget, stripMention } from "./parse.ts";
import type { DirTarget, FoundTarget, KnownRepo, Target } from "./parse.ts";
import { instructionOf, mentionedUsers, parseThreadLink } from "./relay.ts";
import type { UnknownName } from "./relay.ts";
import { clearReports, planPath, relayPath, reportPath, slackPost } from "./report.ts";
import { BUTTON_LABELS, decideRoute, routeHint, routeState } from "./route.ts";
import type { Decision as RouteDecision, RouteAnswer, RouteState } from "./route.ts";
import { buildRelaySpec, buildSpec, taskTitle } from "./spec.ts";
import type { StoreHandle } from "./store.ts";
import { matchUser, userLabel } from "./thread.ts";
import type { SlackUser } from "./thread.ts";

/** The only Slack surface the core needs; Bolt and the console harness both implement it. */
export type Poster = {
  /** `text` is the notification fallback when `blocks` are given. Returns the message ts. */
  postToThread(job: Pick<Job, "slack">, text: string, blocks?: Block[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks?: Block[]): Promise<void>;
  /** Seen only by `user`, in the job's thread. */
  ephemeral(job: Pick<Job, "slack">, user: string, text: string): Promise<void>;
  react(channel: string, messageTs: string, name: string): Promise<void>;
  /** Starts a new thread in the channel; returns its ts. */
  postTopLevel(channel: string, text: string): Promise<string>;
  /** Uploads one local file into the job's thread. */
  uploadFile(job: Pick<Job, "slack">, path: string): Promise<void>;
  /** A link to a message, e.g. a thread's root. */
  permalink(channel: string, ts: string): Promise<string>;
  /** A direct message from the bot to `user`, as a reply in the DM thread `threadTs` when given; returns where it landed, for later updates. */
  dm(user: string, text: string, blocks?: Block[], threadTs?: string): Promise<{ channel: string; ts: string }>;
};

export type BotDeps = {
  orca: Orca;
  poster: Poster;
  store: StoreHandle;
  resolveRepo(owner: string, name: string): Promise<string>;
  /** Channels bound to a local directory by `ALFRED_DIRS`, by channel id: every mention there works in that directory. */
  dirs: Readonly<Record<string, LocalDir>>;
  /** The Orca repo id of a bound directory, looked up on each use. */
  resolveDir(path: string): Promise<string>;
  /** GitHub repos Orca already has, for `!repo` and the change-repo picker. */
  knownRepos(): Promise<KnownRepo[]>;
  latestSession(worktreePath: string, marker?: string): Promise<string | undefined>;
  /** The owners: they start work without asking and approve everyone else's. */
  allowedUsers: ReadonlySet<string>;
  /** Teammates whose requests run only after an owner approves them by DM. */
  approvalUsers: ReadonlySet<string>;
  now?(): number;
  /** Answers a question read-only from a repo checkout, as Markdown. */
  ask(o: { repoPath: string; question: string; thread?: string; files?: readonly LocalFile[] }): Promise<string>;
  botUserId?: string;
  /** Where each job's `in/` and `out/` folders live. */
  filesRoot: string;
  /** A GET of a Slack file URL, authenticated as the bot. */
  fetchFile(url: string): Promise<Response>;
  /** Jev's reading of a plain mention; absent without a TypeSafe key, and then a plain mention is a change. */
  classify?(state: RouteState): Promise<RouteAnswer>;
  /** The workspace's people, to resolve who an owner's private instruction names. */
  users(): Promise<SlackUser[]>;
};

export type Mention = {
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
  text: string;
  context?: string;
  /** The target for a new job, from the mention and its thread; in a bound channel, always its directory. */
  target?: Target;
  /** A target named deterministically by the mention's own text, never by the thread or Claude. */
  ownTarget?: FoundTarget;
  /** The mention started with this command; `text` is what follows it. */
  command?: CommandName;
  /** Slack file objects of the mention and the thread's earlier human messages. */
  files?: readonly unknown[];
};

export type ThreadReply = { channel: string; threadTs: string; ts: string; user: string; text: string; files?: readonly unknown[] };

/** A direct message to the bot; `threadTs` when written inside a DM thread. */
export type DirectMessage = { user: string; text: string; channel: string; ts: string; threadTs?: string };

/** Owners run work and approve; teammates' work waits for an owner; anyone else is refused. */
export type Access = "owner" | "teammate" | "stranger";

export function accessOf(deps: Pick<BotDeps, "allowedUsers" | "approvalUsers">, user: string): Access {
  return deps.allowedUsers.has(user) ? "owner" : deps.approvalUsers.has(user) ? "teammate" : "stranger";
}

/** An owner, or the requester the job runs for, may answer, guide and stop it. */
function mayDrive(deps: BotDeps, job: Job, user: string): boolean {
  return accessOf(deps, user) === "owner" || job.slack.requester === user;
}

function refusal(user: string): string {
  return `Perdón <@${user}>, no tengo permiso para trabajar para vos. Pedile al dueño del bot que agregue tu ID \`${user}\` a ALLOWED_SLACK_USERS.`;
}

/** A validated button or select click, located by the message it came from. */
export type ClickInput = { click: Click; user: string; channel: string; threadTs: string; messageTs: string; context?: string; files?: readonly unknown[] };

/** Thread jobs whose first start is still resolving the repo, before the job exists in the store. */
const starting = new Map<string, Promise<void>>();
const inflightStarts = new Set<Promise<void>>();

/** The inbox waits on this so a question sent before worker-start returns its dispatchId is not dropped as unknown. */
export function startsSettled(): Promise<unknown> {
  return Promise.allSettled([...inflightStarts]);
}

function commit(deps: Pick<BotDeps, "store">, job: Job, ev: JobEvent): Job | undefined {
  const current = deps.store.data.jobs[job.id] ?? job;
  const next = transition(current, ev);
  if (!next) return undefined;
  deps.store.data.jobs[next.id] = next;
  deps.store.save();
  return next;
}

/** A commit that can end the active run; the store write stays synchronous, the Slack edit follows it. */
async function commitEnding(deps: BotDeps, job: Job, ev: JobEvent): Promise<Job | undefined> {
  const before = deps.store.data.jobs[job.id] ?? job;
  const next = commit(deps, job, ev);
  await retireStart(deps, before, next);
  return next;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Brings Slack files into the thread's inbox folder and tells the thread about any it could not bring. */
async function bringFiles(deps: BotDeps, where: Pick<Job, "slack">, raw: readonly unknown[] = []): Promise<LocalFile[]> {
  if (!raw.length) return [];
  const { files, skipped } = selectFiles(raw);
  const got = await downloadFiles(inboxDir(deps.filesRoot, jobId(where.slack.channel, where.slack.threadTs)), files, deps.fetchFile);
  const notice = problemsNotice([...skipped, ...got.failed]);
  if (notice) {
    console.error(`files in ${jobId(where.slack.channel, where.slack.threadTs)}: ${notice}`);
    await deps.poster.postToThread(where, notice).catch((err) => console.error("posting the files notice failed:", err));
  }
  return got.files;
}

/** In a channel bound to a local directory the directory is the only target: links and repo names in the text never move the work elsewhere. */
function inBoundChannel(deps: Pick<BotDeps, "dirs">, m: Mention): Mention {
  const dir = deps.dirs[m.channel];
  return dir ? { ...m, target: { kind: "dir", ...dir }, ownTarget: undefined } : m;
}

export async function handleMention(deps: BotDeps, mention: Mention): Promise<void> {
  const m = inBoundChannel(deps, mention);
  const access = accessOf(deps, m.user);
  const id = jobId(m.channel, m.threadTs);
  const existing = deps.store.data.jobs[id];
  // Whoever the relay asked may answer by mentioning the bot; an owner's mention is a follow-up that ends the wait.
  if (existing && !m.command && access !== "owner" && awaitsReply(existing, m.user, m.ts, false)) return relayReply(deps, existing, m);
  if (access === "stranger") return deps.poster.postToThread(threadOf(m), refusal(m.user));
  switch (m.command) {
    case "aparte":
      return;
    case "ayuda":
      return deps.poster.postToThread(threadOf(m), helpText());
    case "parar":
      if (existing && !mayDrive(deps, existing, m.user)) return deps.poster.postToThread(threadOf(m), `<@${m.user}> no puedo parar este trabajo desde tu pedido.`);
      return cancel(deps, m);
    case "pregunta":
      return perform(deps, m.user, m, "question");
    case "repo":
      return channelRepo(deps, m, access);
    case "nuevo":
      if (m.threadTs !== m.ts) return perform(deps, m.user, m, "new_thread");
  }
  if (existing && m.command !== "nuevo" && m.ownTarget && isOtherTask(existing, m.ownTarget)) {
    if (isActive(existing) && isGuessedRepo(existing) && !sameRepo(existing, m.ownTarget)) {
      if (access === "owner") return correctRepo(deps, existing, m, m.ownTarget);
      return deps.poster.postToThread(existing, `<@${m.user}> no puedo cambiar el repo de este trabajo desde tu pedido.`);
    }
    return replyOtherTask(deps, existing, m.ownTarget);
  }
  if (existing && isActive(existing)) return mayDrive(deps, existing, m.user) ? handleThreadInput(deps, existing, m, { onlyFresh: true }) : undefined;
  if (!m.command && deps.classify) return routeMention(deps, m, existing);
  return perform(deps, m.user, m, commandMode(m.command));
}

/** Work that `actor` (the mention's author, or whoever picked its route) asked for: an owner's runs now, a teammate's waits for an owner. */
async function perform(deps: BotDeps, actor: string, m: Mention, work: Work, note?: string): Promise<void> {
  if (work === "review" && m.target?.kind === "dir") {
    await deps.poster.postToThread(threadOf(m), noReviewIn(m.target));
    return;
  }
  return accessOf(deps, actor) === "owner" ? execute(deps, m, work, note) : requestApproval(deps, m, work, note);
}

function execute(deps: BotDeps, m: Mention, work: Work, note?: string): Promise<void> {
  if (work === "question") return answer(deps, m, note);
  if (work === "new_thread") return startInNewThread(deps, m);
  return runMode(deps, m, work, note);
}

/** What the run would touch, for the card; undefined when it would only ask for the missing repo, PR or question, which needs no approval. */
function plannedTarget(deps: BotDeps, m: Mention, work: Work): { label: string; followUp: boolean } | undefined {
  if (work === "question") return m.text && m.target ? { label: targetLabel(m.target), followUp: false } : undefined;
  const job = deps.store.data.jobs[jobId(m.channel, m.threadTs)];
  if (work !== "new_thread" && job && isResumable(job)) return { label: jobLabel(job), followUp: true };
  const target = work === "review" && m.target?.kind !== "dir" && m.target ? pullTarget(m.target, m.text) : m.target;
  return target && { label: targetLabel(target), followUp: false };
}

function noReviewIn(dir: DirTarget): string {
  return `\`!revisa\` revisa PRs de GitHub, y ${dir.name} es una carpeta local sin PRs. Pedime el cambio directo, \`!investiga\` o \`!plan\`.`;
}

const NOT_NOW = (user: string) => `🙅 <@${user}>, por ahora no puedo tomar este pedido.`;
const EXPIRED = (user: string) => `⌛ <@${user}>, no pude tomar este pedido; si sigue haciendo falta, volvé a mencionarme.`;

/** Stores the request and DMs every owner a card; the teammate only sees 👀 until an owner decides. */
async function requestApproval(deps: BotDeps, m: Mention, work: Work, note?: string): Promise<void> {
  const planned = plannedTarget(deps, m, work);
  if (!planned) return execute(deps, m, work, note);
  const id = approvalId(m);
  if (deps.store.data.approvals[id]) return;
  const link = await deps.poster.permalink(m.channel, m.ts).catch((err) => {
    console.error(`permalink of ${id} failed:`, err);
    return undefined;
  });
  const approval: Approval = { id, mention: m, work, note, target: planned.label, followUp: planned.followUp, link, createdAt: (deps.now ?? Date.now)(), cards: [], state: { kind: "pending" } };
  deps.store.data.approvals[id] = approval;
  deps.store.save();
  await deps.poster.react(m.channel, m.ts, "eyes");
  const card = approvalCard(approval);
  for (const owner of deps.allowedUsers) {
    try {
      const sent = await deps.poster.dm(owner, card.text, card.blocks);
      const current = deps.store.data.approvals[id];
      deps.store.data.approvals[id] = { ...current, cards: [...current.cards, sent] };
      deps.store.save();
    } catch (err) {
      console.error(`DM to ${owner} for ${id} failed:`, err);
    }
  }
  if (deps.store.data.approvals[id].cards.length) return;
  delete deps.store.data.approvals[id];
  deps.store.save();
  await deps.poster.postToThread(threadOf(m), NOT_NOW(m.user));
}

/** Records the decision once, rewrites every owner's card, then runs or turns down the request. */
async function settle(deps: Pick<BotDeps, "poster" | "store">, approval: Approval, decision: Decision): Promise<Approval | undefined> {
  const next = decide(approval, decision);
  if (!next) return undefined;
  deps.store.data.approvals[next.id] = next;
  deps.store.save();
  const card = approvalCard(next);
  for (const c of next.cards) {
    await deps.poster.update(c.channel, c.ts, card.text, card.blocks).catch((err) => console.error(`updating approval card ${c.channel}/${c.ts} failed:`, err));
  }
  const m = next.mention;
  if (next.state.kind === "rejected") await deps.poster.postToThread(threadOf(m), NOT_NOW(m.user));
  if (next.state.kind === "expired") await deps.poster.postToThread(threadOf(m), EXPIRED(m.user));
  return next;
}

/** Pending requests older than a day expire; safe to call on every tick. */
export async function expireApprovals(deps: Pick<BotDeps, "poster" | "store" | "now">, now = (deps.now ?? Date.now)()): Promise<void> {
  for (const approval of dueExpiries(deps.store.data.approvals, now)) {
    await settle(deps, approval, { kind: "expired" });
  }
}

async function decideApproval(deps: BotDeps, input: ClickInput, click: Extract<Click, { kind: "approval" }>): Promise<void> {
  const where = { slack: { channel: input.channel, threadTs: input.messageTs, requester: input.user } };
  if (accessOf(deps, input.user) !== "owner") return deps.poster.ephemeral(where, input.user, `Perdón <@${input.user}>, este botón no es para vos.`);
  await expireApprovals(deps);
  const approval = deps.store.data.approvals[click.approvalId];
  if (!approval) return deps.poster.ephemeral(where, input.user, "No encuentro ese pedido.");
  const decided = await settle(deps, approval, click.decision === "approve" ? { kind: "approved", by: input.user } : { kind: "rejected", by: input.user });
  if (!decided) {
    const state = deps.store.data.approvals[click.approvalId].state;
    return deps.poster.ephemeral(where, input.user, state.kind === "expired" ? "Ese pedido ya venció." : "Ese pedido ya está decidido.");
  }
  if (decided.state.kind === "approved") await execute(deps, decided.mention, decided.work, decided.note);
}

/** `note` is appended to the start message, to say how a mention without a command was understood. */
function runMode(deps: BotDeps, m: Mention, mode: Mode, note?: string): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  const existing = deps.store.data.jobs[id];
  if (existing && isActive(existing)) return handleThreadInput(deps, existing, m, { onlyFresh: true });
  if (existing && isResumable(existing)) return holdingDir(deps, existing, dirOf(existing), () => startFollowUp(deps, existing, m, mode, note));
  if (starting.has(id)) return Promise.resolve();
  return startJob(deps, m, mode, undefined, note);
}

function dirOf(job: Job): LocalDir | undefined {
  return job.repo.kind === "dir" ? job.repo : undefined;
}

/** A plain mention: Jev picks the route when it is sure enough for what that route costs, otherwise the human does. */
async function routeMention(deps: BotDeps, m: Mention, job: Job | undefined): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  let decision: RouteDecision;
  try {
    const answer = await deps.classify!(routeState(m, job));
    decision = decideRoute(answer);
    console.log(`route ${id}: ${answer.choice} @ ${answer.confidence.toFixed(2)} → ${decision.kind === "ask" ? "ask" : decision.route}`);
  } catch (err) {
    console.error(`routing ${id} failed, asking instead:`, err);
    decision = { kind: "ask" };
  }
  if (decision.kind === "ask") return askRoute(deps, m);
  if (decision.route === "none") return deps.poster.react(m.channel, m.ts, "thumbsup");
  return perform(deps, m.user, m, decision.route, routeHint(decision.route));
}

async function askRoute(deps: BotDeps, m: Mention): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  const msg = routeAskMessage(id);
  const ts = await deps.poster.postToThread(threadOf(m), msg.text, msg.blocks);
  const previous = deps.store.data.pendingRoutes[id];
  deps.store.data.pendingRoutes[id] = { ts, mention: m };
  deps.store.save();
  if (previous) await retireButtons(deps, m.channel, { ts: previous.ts, text: ROUTE_QUESTION });
}

/** A repo nobody named for this job, so naming another one corrects it instead of opening a separate task. */
function isGuessedRepo(job: Job): boolean {
  return job.repoSource === "inferred" || job.repoSource === "channel";
}

function threadOf(m: Pick<Mention, "channel" | "threadTs" | "user">): Pick<Job, "slack"> {
  return { slack: { channel: m.channel, threadTs: m.threadTs, requester: m.user } };
}

function quote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

async function startInNewThread(deps: BotDeps, m: Mention): Promise<void> {
  const asked = `🆕 <@${m.user}> pidió una tarea aparte desde otro hilo${m.text ? `:\n${quote(m.text)}` : "."}`;
  const threadTs = await deps.poster.postTopLevel(m.channel, asked);
  await deps.poster.postToThread(threadOf(m), "🆕 la sigo en un hilo aparte.");
  return startJob(deps, { ...m, threadTs }, "change");
}

async function replyOtherTask(deps: BotDeps, job: Job, target: FoundTarget): Promise<void> {
  const how = deps.botUserId ? `escribí <@${deps.botUserId}> \`!nuevo …\`` : "mencioname con `!nuevo …`";
  await deps.poster.postToThread(job, `Este hilo es de ${jobLabel(job)}. Si querés que tome ${targetLabel(target)} como tarea aparte, ${how}.`);
}

/** The user named the right repo after the bot guessed wrong: stop the guess and redo the original request there. */
async function correctRepo(deps: BotDeps, job: Job, m: Mention, target: FoundTarget): Promise<void> {
  // A worker still starting has no dispatchId to stop yet; let it settle first, as !parar does.
  if (job.state.kind === "starting") await startsSettled();
  const current = deps.store.data.jobs[job.id] ?? job;
  const label = targetLabel(target);
  const redo = () => startJob(deps, { ...m, user: current.slack.requester, text: current.request, target }, current.mode, `🔁 cambio a ${label}.`);
  if (current.state.kind === "failed") return redo();
  if (!isActive(current) || !current.dispatchId) return;
  try {
    await deps.orca.stopWorker(current.dispatchId);
  } catch (err) {
    console.error(`worker-stop ${current.dispatchId} failed:`, err);
    await deps.poster.postToThread(current, `❌ no pude frenar el worker de ${jobLabel(current)} (${errorText(err)}), así que no arranco otro en ${label}.`);
    return;
  }
  await commitEnding(deps, current, { kind: "superseded", reason: `el usuario corrigió el repo a ${label}` });
  await redo();
}

/** Posts the message that announces a worker, with its stop button. */
async function postStart(
  deps: BotDeps,
  where: Pick<Job, "slack">,
  text: string,
  picker?: { current: RepoRef; repos: readonly RepoRef[] },
): Promise<{ ts: string; text: string }> {
  const msg = startMessage({ jobId: jobId(where.slack.channel, where.slack.threadTs), text, ...picker });
  return { ts: await deps.poster.postToThread(where, msg.text, msg.blocks), text };
}

async function retireButtons(deps: Pick<BotDeps, "poster">, channel: string, msg: { ts: string; text: string }): Promise<void> {
  const plain = plainMessage(msg.text);
  await deps.poster.update(channel, msg.ts, plain.text, plain.blocks).catch((err) => console.error(`removing buttons from ${channel}/${msg.ts} failed:`, err));
}

/** Call after any commit that may have ended the job's active run: its start message loses its buttons. */
export async function retireStart(deps: Pick<BotDeps, "poster">, before: Job | undefined, after: Job | undefined): Promise<void> {
  if (!before?.startMsg || !after || !isActive(before) || isActive(after)) return;
  await retireButtons(deps, before.slack.channel, before.startMsg);
}

/** The thread whose run holds each local directory while its worker starts, before the job is stored as active. */
const dirClaims = new Map<string, string>();

/** The thread other than `id`'s that holds a local directory: one starting there, or an active job. */
function dirHolder(deps: Pick<BotDeps, "store">, path: string, id: string): string | undefined {
  const claimed = dirClaims.get(path);
  return claimed && claimed !== id ? claimed : activeJobInDir(deps.store.data, path, id)?.id;
}

function threadLink(deps: Pick<BotDeps, "poster">, id: string): Promise<string> {
  const at = id.indexOf(":");
  return deps.poster.permalink(id.slice(0, at), id.slice(at + 1)).catch(() => id);
}

async function busyText(deps: Pick<BotDeps, "poster">, dir: LocalDir, holder: string): Promise<string> {
  return `estoy con otro pedido en ${dir.name} (${await threadLink(deps, holder)}); avisame cuando termine`;
}

/**
 * Runs `start` holding `dir` for the thread, so a second request there waits for the first instead of editing the same files.
 * Without a directory, `start` just runs.
 */
async function holdingDir(deps: BotDeps, where: Pick<Job, "slack">, dir: LocalDir | undefined, start: () => Promise<void>): Promise<void> {
  if (!dir) return start();
  const id = jobId(where.slack.channel, where.slack.threadTs);
  const holder = dirHolder(deps, dir.path, id);
  if (holder) {
    await deps.poster.postToThread(where, await busyText(deps, dir, holder));
    return;
  }
  dirClaims.set(dir.path, id);
  try {
    await start();
  } finally {
    if (dirClaims.get(dir.path) === id) dirClaims.delete(dir.path);
  }
}

function startJob(deps: BotDeps, m: Mention, mode: Mode, intro?: string, note?: string): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  const dir = m.target?.kind === "dir" ? m.target : undefined;
  const p = holdingDir(deps, threadOf(m), dir, () => startJobOnce(deps, m, mode, intro, note)).finally(() => starting.delete(id));
  starting.set(id, p);
  return p;
}

const SAME_SESSION = "en la misma sesión";

const START_TEXT: Record<Mode, { first(label: string, issue: boolean, guessed: string): string; followUp: string }> = {
  change: {
    first: (label, issue, guessed) => `🫡 tomo ${issue ? "el issue" : "el pedido en"} ${label}${guessed}. Te aviso por acá.`,
    followUp: `🫡 sigo ${SAME_SESSION}. Te aviso por acá.`,
  },
  investigate: { first: (label, _issue, guessed) => `🔎 investigo en ${label}${guessed}…`, followUp: `🔎 investigo ${SAME_SESSION}…` },
  plan: {
    first: (label, _issue, guessed) => `📋 armo un plan en ${label}${guessed}, te lo muestro antes de tocar código.`,
    followUp: `📋 armo un plan ${SAME_SESSION}; te lo muestro antes de tocar código.`,
  },
  review: { first: (label, _issue, guessed) => `🔍 reviso ${label}${guessed}…`, followUp: `🔍 reviso ${SAME_SESSION}…` },
};

const FRESH_FOLLOW_UP = "⚠️ no pude retomar la sesión anterior: sigo con un worker nuevo en el mismo worktree, que arranca del resumen de lo que se hizo.";

function runPaths(deps: BotDeps, id: string) {
  return { reportPath: reportPath(id), planPath: planPath(id), outbox: outboxDir(deps.filesRoot, id) };
}

function withNote(text: string, note: string | undefined): string {
  return note ? `${text}\n_${note}_` : text;
}

async function startJobOnce(deps: BotDeps, m: Mention, mode: Mode, intro?: string, note?: string): Promise<void> {
  const where = threadOf(m);
  const target = mode === "review" && m.target?.kind !== "dir" && m.target ? pullTarget(m.target, m.text) : m.target;
  if (!target) {
    const missing =
      mode === "review"
        ? "no sé qué PR revisar. Pasame el link del PR (o `owner/repo#123`, o `#123` si el repo ya está claro)"
        : "no encontré qué repo o issue tocar. Pasame el link del issue de GitHub (o `owner/repo#123`)";
    await deps.poster.postToThread(where, `<@${m.user}> ${missing} en este hilo y mencioname de nuevo.`);
    return;
  }

  if (target.kind === "dir") return startInDir(deps, m, target, mode, intro, note);
  const { owner, name, issue, source } = target;
  const label = targetLabel(target);
  const guessed =
    source === "inferred" ? " (lo deduje del hilo; si no es ese, mencioname con el repo correcto)" : source === "channel" ? " (repo del canal)" : "";
  await deps.poster.react(m.channel, m.ts, "saluting_face");
  const picker = source === "inferred" || source === "channel" ? { current: { owner, name }, repos: await knownReposOrNone(deps) } : undefined;
  const startMsg = await postStart(deps, where, withNote(intro ?? START_TEXT[mode].first(label, issue !== undefined, guessed), note), picker);
  let orcaRepoId: string;
  try {
    orcaRepoId = await deps.resolveRepo(owner, name);
  } catch (err) {
    await retireButtons(deps, where.slack.channel, startMsg);
    await deps.poster.postToThread(where, `❌ <@${m.user}> no pude preparar el repo ${owner}/${name}: ${errorText(err)}`);
    return;
  }
  const job = newJob({ ...where, repo: { owner, name, orcaRepoId }, repoSource: source, issue, request: m.text, mode, startMsg });
  deps.store.data.jobs[job.id] = job;
  deps.store.save();
  const earlier = await announceAntecedents(deps, job);
  const files = await bringFiles(deps, where, m.files);
  await launch(deps, job, () =>
    deps.orca.startWorker({
      repoId: orcaRepoId,
      name: slug(`${name}-${issue ? `issue-${issue.number}` : "slack"}-${m.threadTs.replace(".", "").slice(-8)}`),
      title: taskTitle(job),
      spec: buildSpec({ job, context: m.context, files, earlier, ...runPaths(deps, job.id) }),
    }),
  );
}

/** A first run in a bound channel's directory: on its existing main worktree, never a new one, so the work lands where the team keeps it. */
async function startInDir(deps: BotDeps, m: Mention, dir: DirTarget, mode: Mode, intro?: string, note?: string): Promise<void> {
  const where = threadOf(m);
  await deps.poster.react(m.channel, m.ts, "saluting_face");
  const startMsg = await postStart(deps, where, withNote(intro ?? START_TEXT[mode].first(dir.name, false, ""), note));
  let orcaRepoId: string;
  try {
    orcaRepoId = await deps.resolveDir(dir.path);
  } catch (err) {
    await retireButtons(deps, where.slack.channel, startMsg);
    await deps.poster.postToThread(where, `❌ <@${m.user}> no encuentro la carpeta ${dir.name} en Orca: ${errorText(err)}`);
    return;
  }
  const repo = { kind: "dir" as const, name: dir.name, path: dir.path, orcaRepoId };
  const job = newJob({ ...where, repo, worktreeId: `${orcaRepoId}::${dir.path}`, request: m.text, mode, startMsg });
  deps.store.data.jobs[job.id] = job;
  deps.store.save();
  const files = await bringFiles(deps, where, m.files);
  await launch(deps, job, () =>
    deps.orca.startInWorktree({ worktree: `path:${dir.path}`, title: taskTitle(job), spec: buildSpec({ job, context: m.context, files, ...runPaths(deps, job.id) }) }),
  );
}

/** Tells the thread, and returns for the spec, which other threads already worked on this job's issue or PR. */
async function announceAntecedents(deps: BotDeps, job: Job): Promise<EarlierWork[]> {
  if (job.repo.kind === "dir") return [];
  const found = findAntecedents(Object.values(deps.store.data.jobs), { ...job.repo, issue: job.issue }, job.id);
  if (!found.length) return [];
  const earlier = await Promise.all(
    found.map(async (j) =>
      earlierWork(
        j,
        await deps.poster.permalink(j.slack.channel, j.slack.threadTs).catch((err) => {
          console.error(`permalink of ${j.id} failed:`, err);
          return undefined;
        }),
      ),
    ),
  );
  await deps.poster.postToThread(job, antecedentsPost(earlier)).catch((err) => console.error(`posting antecedents in ${job.id} failed:`, err));
  return earlier;
}

const CANCELLED_SUMMARY = "The user cancelled the previous worker before it finished. Its work so far is whatever is committed or left uncommitted in this worktree.";

async function startFollowUp(deps: BotDeps, job: Job, m: Mention, mode: Mode, note?: string): Promise<void> {
  if (!isResumable(job) || !job.worktreeId) return;
  const run = lastRun(job);
  const previous = run?.kind === "done" ? run : { summary: CANCELLED_SUMMARY, prUrl: undefined };
  const worktree = worktreeSelector(job.worktreeId);
  const next = commit(deps, job, { kind: "follow_up", request: m.text, mode, requester: m.user });
  if (!next) return;
  await deps.poster.react(m.channel, m.ts, "saluting_face");
  const startMsg = await postStart(deps, next, withNote(START_TEXT[mode].followUp, note));
  const current = deps.store.data.jobs[next.id];
  if (current === next) {
    deps.store.data.jobs[next.id] = { ...next, startMsg };
    deps.store.save();
  }
  const title = `${taskTitle(next)} (follow-up)`;
  const files = (await bringFiles(deps, next, m.files)).filter((f) => f.fresh);
  const paths = { files, ...runPaths(deps, next.id) };
  await launch(deps, next, async () => {
    if (next.sessionId) {
      try {
        const spec = buildSpec({ job: next, resumed: true, previousPrUrl: previous.prUrl, ...paths });
        const started = await resumeSession(deps, { worktree, sessionId: next.sessionId, title, spec });
        console.log(`follow-up ${next.id}: resumed Claude session ${next.sessionId}`);
        return started;
      } catch (err) {
        console.error(`follow-up ${next.id}: resuming session ${next.sessionId} failed, starting a fresh worker:`, err);
      }
    }
    console.log(`follow-up ${next.id}: fresh worker`);
    await deps.poster.postToThread(next, FRESH_FOLLOW_UP).catch(() => {});
    return deps.orca.startInWorktree({
      worktree,
      title,
      spec: buildSpec({ job: next, previousSummary: previous.summary, previousPrUrl: previous.prUrl, ...paths }),
    });
  });
}

/** Reopens the previous worker's Claude session in the worktree and hands it the follow-up as a supervised worker. */
async function resumeSession(
  deps: BotDeps,
  opts: { worktree: string; sessionId: string; title: string; spec: string },
): Promise<WorkerStart> {
  const handle = await deps.orca.createTerminal({
    worktree: opts.worktree,
    title: slug(opts.title),
    command: `claude --dangerously-skip-permissions --resume ${opts.sessionId}`,
  });
  try {
    // A long session can take more than a minute to load; one longer retry before giving up.
    const idle = (await deps.orca.waitTuiIdle(handle, 60_000)) || (await deps.orca.waitTuiIdle(handle, 120_000));
    if (!idle) throw new Error(`resumed Claude in ${handle} never became idle`);
    return await deps.orca.startWorkerInTerminal({ worktree: opts.worktree, handle, title: opts.title, spec: opts.spec });
  } catch (err) {
    await deps.orca.closeTerminal(handle).catch((closeErr) => console.error(`closing terminal ${handle} failed:`, closeErr));
    throw err;
  }
}

/** Ask mode: no Job, worktree or PR, and an existing job in the thread is left alone. */
async function answer(deps: BotDeps, m: Mention, note?: string): Promise<void> {
  const where = threadOf(m);
  if (!m.text) {
    await deps.poster.postToThread(where, "Escribí la pregunta después del comando: `!pregunta ¿dónde se valida el token?`");
    return;
  }
  if (!m.target) {
    await deps.poster.postToThread(where, `<@${m.user}> no sé de qué repo es la pregunta. Nombrá el repo (o pasá un link de GitHub) en este hilo y preguntame de nuevo.`);
    return;
  }
  await deps.poster.react(m.channel, m.ts, "eyes");
  try {
    const repoPath = m.target.kind === "dir" ? m.target.path : await deps.orca.repoPath(await deps.resolveRepo(m.target.owner, m.target.name));
    const files = await bringFiles(deps, where, m.files);
    const text = await deps.ask({ repoPath, question: m.text, thread: m.context, files });
    await deps.poster.postToThread(where, withNote(slackPost(text), note));
  } catch (err) {
    console.error(`ask in ${jobId(m.channel, m.threadTs)} failed:`, err);
    await deps.poster.postToThread(where, `❌ no pude responder: ${errorText(err)}`);
  }
}

function knownReposOrNone(deps: BotDeps): Promise<KnownRepo[]> {
  return deps.knownRepos().catch((err) => {
    console.error("listing known repos failed:", err);
    return [];
  });
}

/** Bound directories are listed but never join `repos`, which also feeds repo guessing and the change-repo picker. */
function knownList(repos: readonly KnownRepo[], dirs: Readonly<Record<string, LocalDir>>): string {
  const local = [...new Map(Object.values(dirs).map((d) => [d.path, d])).values()].map((d) => `\`${d.name}\` (carpeta local)`);
  const all = [...repos.map((r) => `\`${r.owner}/${r.name}\``), ...local];
  return all.length ? `Repos que conozco: ${all.join(", ")}.` : "Orca no tiene repos de GitHub cargados todavía.";
}

async function channelRepo(deps: BotDeps, m: Mention, access: Access): Promise<void> {
  const repos = await knownReposOrNone(deps);
  const arg = parseRepoArg(m.text, repos);
  const dir = deps.dirs[m.channel];
  if (dir) {
    const text =
      arg.kind === "show"
        ? `📁 este canal trabaja en la carpeta local ${dir.name} (\`${dir.path}\`), sin GitHub.\n${knownList(repos, deps.dirs)}`
        : `Este canal está atado a la carpeta local ${dir.name} (\`ALFRED_DIRS\`), así que no le fijo otro repo. Para un repo de GitHub, pedímelo en otro canal.`;
    await deps.poster.postToThread(threadOf(m), text);
    return;
  }
  if (access !== "owner" && (arg.kind === "set" || arg.kind === "clear")) {
    await deps.poster.postToThread(threadOf(m), "No puedo cambiar el repo de este canal desde tu pedido.");
    return;
  }
  const channels = deps.store.data.channels;
  const current = channels[m.channel];
  let text: string;
  switch (arg.kind) {
    case "show":
      text = `${current ? `📌 repo de este canal: ${targetLabel(current)}` : "Este canal no tiene repo por defecto."}\n${knownList(repos, deps.dirs)}`;
      break;
    case "clear":
      delete channels[m.channel];
      deps.store.save();
      text = current ? `🗑️ saqué ${targetLabel(current)} como repo de este canal.` : "Este canal no tenía repo por defecto.";
      break;
    case "set":
      channels[m.channel] = arg.repo;
      deps.store.save();
      text = `📌 repo de este canal: ${targetLabel(arg.repo)}`;
      break;
    case "unknown":
      text = `No reconozco \`${arg.text}\` como repo. Pasame un link de GitHub, \`owner/nombre\` o el nombre exacto de un repo de Orca.\n${knownList(repos, deps.dirs)}`;
      break;
  }
  await deps.poster.postToThread(threadOf(m), text);
}

async function cancel(deps: BotDeps, m: Pick<Mention, "channel" | "threadTs" | "user">): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  // A start in flight has no dispatchId yet; let it settle so there is a worker to stop.
  await starting.get(id);
  if (deps.store.data.jobs[id]?.state.kind === "starting") await startsSettled();
  const job = deps.store.data.jobs[id];
  if (!job || !isActive(job) || !job.dispatchId) {
    await deps.poster.postToThread(threadOf(m), "No hay nada corriendo en este hilo.");
    return;
  }
  try {
    await deps.orca.stopWorker(job.dispatchId);
  } catch (err) {
    console.error(`worker-stop ${job.dispatchId} failed:`, err);
    await deps.poster.postToThread(job, `❌ no pude parar el worker (${errorText(err)}). Sigue como estaba.`);
    return;
  }
  const worktreeId = job.worktreeId;
  const [sessionId, branch] = worktreeId
    ? await Promise.all([
        deps.latestSession(worktreePath(worktreeId), jobSlug(job.id)).catch(() => undefined),
        deps.orca.currentBranch(worktreeId).catch(() => undefined),
      ])
    : [];
  if (!(await commitEnding(deps, job, { kind: "cancelled", sessionId }))) return;
  const kept = job.repo.kind === "dir" ? `en la carpeta ${job.repo.name}` : `en la rama ${branch ? `\`${branch}\`` : "del worktree"}`;
  await deps.poster.postToThread(job, `⏹️ cancelado. El trabajo queda ${kept} por si querés retomarlo (mencioname en este hilo).`);
}

function tracked(start: Promise<void>): Promise<void> {
  const p = start.finally(() => inflightStarts.delete(p));
  inflightStarts.add(p);
  return p;
}

function launch(deps: BotDeps, job: Job, start: () => ReturnType<Orca["startWorker"]>): Promise<void> {
  return tracked(launchOnce(deps, job, start));
}

async function launchOnce(deps: BotDeps, job: Job, start: () => ReturnType<Orca["startWorker"]>): Promise<void> {
  try {
    await clearReports(job.id);
    await mkdir(outboxDir(deps.filesRoot, job.id), { recursive: true });
    const base = job.repo.kind === "dir" ? await deps.orca.headSha(job.repo.path) : undefined;
    const w = await start();
    commit(deps, job, { kind: "started", worktreeId: w.worktreeId ?? job.worktreeId ?? "", taskId: w.taskId, dispatchId: w.dispatchId, base });
  } catch (err) {
    console.error(`worker start failed for ${job.id}:`, err);
    await commitEnding(deps, job, { kind: "start_failed", error: errorText(err) });
    await deps.poster.postToThread(job, `❌ <@${job.slack.requester}> no pude arrancar el worker: ${errorText(err)}`);
  }
}

/** Questions whose `orca reply` is in flight, so a click and a typed reply racing each other answer once. */
const answering = new Set<string>();

/** Answers the pending question, typed or clicked, and retires its buttons. False when nothing is pending anymore. */
async function answerWorker(deps: BotDeps, job: Job, text: string, user: string, shown = text): Promise<boolean> {
  const state = job.state;
  if (state.kind !== "awaiting_answer" || answering.has(state.questionMsgId)) return false;
  answering.add(state.questionMsgId);
  try {
    await deps.orca.reply(state.questionMsgId, text);
    commit(deps, job, { kind: "answered" });
  } finally {
    answering.delete(state.questionMsgId);
  }
  if (state.postTs) {
    const done = answeredMessage({ requester: job.slack.requester, question: state.question, user, answer: shown });
    await deps.poster.update(job.slack.channel, state.postTs, done.text, done.blocks).catch((err) => console.error(`retiring question buttons in ${job.id} failed:`, err));
  }
  return true;
}

/**
 * Text and files from the thread reach the worker as guidance, or as the answer to its question.
 * `onlyFresh` drops files an earlier message already brought, since a mention carries the whole thread's files.
 */
async function handleThreadInput(
  deps: BotDeps,
  job: Job,
  input: { ts: string; text: string; channel: string; user: string; files?: readonly unknown[] },
  { onlyFresh = false } = {},
): Promise<void> {
  const state = job.state;
  if (state.kind === "starting") {
    await deps.poster.postToThread(job, "Todavía estoy arrancando el worker. Mandalo de nuevo en un minuto.");
    return;
  }
  if (state.kind !== "awaiting_answer" && !(state.kind === "working" && job.dispatchId)) return;
  const files = (await bringFiles(deps, job, input.files)).filter((f) => f.fresh || !onlyFresh);
  const message = withFiles(input.text, files);
  if (!message) return;
  const current = deps.store.data.jobs[job.id] ?? job;
  if (current.state.kind === "awaiting_answer") {
    if (await answerWorker(deps, current, message, input.user, shownText(input.text, files))) await deps.poster.react(input.channel, input.ts, "white_check_mark");
  } else if (current.state.kind === "working" && current.dispatchId) {
    await deps.orca.send(current.dispatchId, message);
    await deps.poster.react(input.channel, input.ts, "eyes");
  }
}

/** Plain thread replies (no mention). Returns false when the thread has no active job; an `!aparte` reply counts as handled. */
export async function handleThreadReply(deps: BotDeps, r: ThreadReply): Promise<boolean> {
  if (parseCommand(r.text)?.name === "aparte") return true;
  const job = deps.store.data.jobs[jobId(r.channel, r.threadTs)];
  if (job?.state.kind === "awaiting_reply") {
    if (awaitsReply(job, r.user, r.ts, accessOf(deps, r.user) === "owner")) await relayReply(deps, job, r);
    return true;
  }
  if (!job || !isActive(job)) return false;
  if (mayDrive(deps, job, r.user)) await handleThreadInput(deps, job, r);
  return true;
}

/** Jobs a stop or change-repo click is already stopping, so a double click stops once. */
const stopping = new Set<string>();

const STALE = "Ese botón ya no es válido: el hilo siguió de largo.";

/** Buttons run the same paths as typed input. A click on a message the job has moved past changes nothing. */
export async function handleClick(deps: BotDeps, input: ClickInput): Promise<void> {
  const where = { slack: { channel: input.channel, threadTs: input.threadTs, requester: input.user } };
  const { click } = input;
  if (click.kind === "approval") return decideApproval(deps, input, click);
  const access = accessOf(deps, input.user);
  if (access === "stranger") return deps.poster.ephemeral(where, input.user, refusal(input.user));
  if (click.jobId !== jobId(input.channel, input.threadTs)) return deps.poster.ephemeral(where, input.user, STALE);
  // A start in flight posts its buttons before the job is stored.
  await starting.get(click.jobId);
  const job = deps.store.data.jobs[click.jobId];
  if (access === "teammate" && !teammateMayClick(deps, click, job, input.user)) {
    return deps.poster.ephemeral(where, input.user, `Perdón <@${input.user}>, este botón no es para vos.`);
  }
  const onStartMsg = job !== undefined && isActive(job) && job.startMsg?.ts === input.messageTs;
  let handled = false;
  switch (click.kind) {
    case "stop":
      if (onStartMsg && !stopping.has(job.id)) {
        handled = true;
        stopping.add(job.id);
        await cancel(deps, input).finally(() => stopping.delete(job.id));
      }
      break;
    case "repo": {
      const known = (await knownReposOrNone(deps)).find((r) => r.owner === click.repo.owner && r.name === click.repo.name);
      if (onStartMsg && known && isGuessedRepo(job) && !sameRepo(job, known) && !stopping.has(job.id)) {
        handled = true;
        stopping.add(job.id);
        const m = { channel: input.channel, threadTs: input.threadTs, ts: input.threadTs, user: input.user, text: job.request, context: input.context, files: input.files };
        await correctRepo(deps, job, m, { owner: known.owner, name: known.name, source: "name" }).finally(() => stopping.delete(job.id));
      }
      break;
    }
    case "answer": {
      const state = job?.state;
      const option = state?.kind === "awaiting_answer" && state.questionMsgId === click.questionMsgId && state.postTs === input.messageTs ? state.options[click.option] : undefined;
      if (option === PLAN_OPTIONS.change && job!.mode === "plan") {
        await deps.poster.ephemeral(where, input.user, "Escribí en el hilo qué querés cambiar.");
        return;
      }
      handled = option !== undefined && (await answerWorker(deps, job!, option, input.user));
      break;
    }
    case "route": {
      const pending = deps.store.data.pendingRoutes[click.jobId];
      if (pending?.ts === input.messageTs) {
        handled = true;
        delete deps.store.data.pendingRoutes[click.jobId];
        deps.store.save();
        const chosen = plainMessage(`${ROUTE_QUESTION}\n✅ elegido: ${BUTTON_LABELS[click.route]}`);
        await deps.poster.update(input.channel, input.messageTs, chosen.text, chosen.blocks).catch((err) => console.error(`retiring route buttons in ${click.jobId} failed:`, err));
        await perform(deps, input.user, pending.mention, click.route);
      }
      break;
    }
  }
  if (!handled) await deps.poster.ephemeral(where, input.user, STALE);
}

/** A teammate drives only their own job (stop, answers) and picks the route only of their own mention; changing a running job's repo stays with the owners. */
function teammateMayClick(deps: BotDeps, click: Exclude<Click, { kind: "approval" }>, job: Job | undefined, user: string): boolean {
  switch (click.kind) {
    case "stop":
    case "answer":
      return job?.slack.requester === user;
    case "route":
      return deps.store.data.pendingRoutes[click.jobId]?.mention.user === user;
    case "repo":
      return false;
  }
}

const RELAY_USAGE = "Pegá el link de un mensaje del hilo y qué querés que haga, por ejemplo: `<link> preguntale a @salva por qué guardó los permisos en esa tabla`. Después podés seguir sin el link: voy al último hilo del que me hablaste.";

/**
 * An owner's private instruction for a thread's session. Nothing reaches the thread but a message the worker writes,
 * so nobody there learns the owner asked for it; every answer and failure goes back by DM, naming the thread.
 * A DM without a link continues the owner's last thread, so the private conversation goes on in the same session.
 */
export async function handleDm(deps: BotDeps, dm: DirectMessage): Promise<void> {
  if (accessOf(deps, dm.user) !== "owner") return;
  const dmThread = dm.threadTs ?? dm.ts;
  const tell = async (text: string) => {
    await deps.poster.dm(dm.user, text, undefined, dmThread).catch((err) => console.error(`DM to ${dm.user} failed:`, err));
  };
  const data = deps.store.data;
  const dmKey = `${dm.channel}:${dmThread}`;
  const text = stripMention(dm.text, deps.botUserId ?? "");
  const link = parseThreadLink(text);
  const id = link ? jobId(link.channel, link.threadTs) : ((dm.threadTs && data.jobByDmThread[dmKey]) ?? data.lastThreadByOwner[dm.user]);
  const instruction = link ? instructionOf(text, link) : text.trim();
  if (!id || !instruction) return tell(RELAY_USAGE);
  await starting.get(id);
  const job = data.jobs[id];
  if (!job) return tell(link ? "no tengo un trabajo en ese hilo" : "no tengo un trabajo en el último hilo que me pasaste; pegame el link de otro");
  if (data.lastThreadByOwner[dm.user] !== id || data.jobByDmThread[dmKey] !== id) {
    data.lastThreadByOwner[dm.user] = id;
    data.jobByDmThread[dmKey] = id;
    deps.store.save();
  }
  const thread = await deps.poster.permalink(job.slack.channel, job.slack.threadTs).catch(() => link?.url ?? id);
  if (isActive(job)) return tell(`ese hilo está trabajando ahora; mandámelo cuando termine (${thread})`);
  if (!isResumable(job) || !job.sessionId) return tell(`no tengo una sesión que pueda retomar en ${thread}`);
  const named = await namedPeople(deps, instruction);
  const dir = dirOf(job);
  const holder = dir && dirHolder(deps, dir.path, id);
  if (dir && holder) return tell(await busyText(deps, dir, holder));
  const next = commit(deps, job, { kind: "relay", relay: { owner: dm.user, dmThread, instruction, ...named, link: thread } });
  if (!next) return;
  await tell(`👌 voy con eso en ${thread}`);
  await launchRelay(deps, next);
}

/** A name that matches nobody is still passed on: it only matters if the worker would write to that person, which the relay file's parser refuses. */
async function namedPeople(deps: BotDeps, instruction: string): Promise<{ people: Person[]; unknown: UnknownName[] }> {
  const queries = mentionedUsers(instruction);
  const people: Person[] = [];
  const unknown: UnknownName[] = [];
  if (!queries.length) return { people, unknown };
  const users = await deps.users().catch((err: unknown) => errorText(err));
  for (const q of queries) {
    if (typeof users === "string") {
      unknown.push({ name: q, why: `no pude buscar a "${q}" en Slack (${users})` });
      continue;
    }
    try {
      const user = matchUser(users, q);
      people.push({ id: user.id, name: userLabel(user) });
    } catch (err) {
      unknown.push({ name: q, why: errorText(err) });
    }
  }
  return { people, unknown };
}

/** Resumes the thread's own session for the relay's current step; a session that will not resume is the owner's to hear about, never the thread's. */
function launchRelay(deps: BotDeps, job: Job): Promise<void> {
  return tracked(launchRelayOnce(deps, job));
}

async function launchRelayOnce(deps: BotDeps, job: Job): Promise<void> {
  if (job.state.kind !== "relaying" || !job.worktreeId || !job.sessionId) return;
  const { relay, step } = job.state;
  try {
    await clearReports(job.id);
    const spec = buildRelaySpec({ job, relay, step, relayPath: relayPath(job.id) });
    const w = await resumeSession(deps, { worktree: worktreeSelector(job.worktreeId), sessionId: job.sessionId, title: `${taskTitle(job)} (relay)`, spec });
    console.log(`relay ${job.id} (${step.kind}): resumed Claude session ${job.sessionId}`);
    commit(deps, job, { kind: "started", worktreeId: job.worktreeId, taskId: w.taskId, dispatchId: w.dispatchId });
  } catch (err) {
    console.error(`relay ${job.id}: resuming session ${job.sessionId} failed:`, err);
    commit(deps, job, { kind: "relay_ended" });
    await deps.poster
      .dm(relay.owner, `❌ no pude retomar la sesión de ${relay.link} (${errorText(err)}), así que no escribí nada en el hilo.`, undefined, relay.dmThread)
      .catch((dmErr) => console.error(`DM to ${relay.owner} failed:`, dmErr));
  }
}

/** Only the first qualifying reply runs: `commit` applies to the stored job, which a first reply has already moved past awaiting_reply. */
async function relayReply(deps: BotDeps, job: Job, r: { user: string; text: string }): Promise<void> {
  if (job.state.kind !== "awaiting_reply") return;
  const { relay } = job.state;
  const from = relay.people.find((p) => p.id === r.user) ?? { id: r.user, name: await nameOf(deps, r.user) };
  const dir = dirOf(job);
  const holder = dir && dirHolder(deps, dir.path, job.id);
  const next = commit(deps, job, { kind: "relay_reply", from, text: r.text });
  if (!next) return;
  if (!dir || !holder) return launchRelay(deps, next);
  // Its directory is busy with another thread's run, so the owner gets the reply as written instead of a digest.
  commit(deps, next, { kind: "relay_ended" });
  const text = `💬 ${from.name} respondió en ${relay.link}:\n${quote(r.text)}\n_No lo resumí porque estoy con otro pedido en ${dir.name} (${await threadLink(deps, holder)})._`;
  await deps.poster.dm(relay.owner, text, undefined, relay.dmThread).catch((err) => console.error(`DM to ${relay.owner} failed:`, err));
}

async function nameOf(deps: BotDeps, id: string): Promise<string> {
  const user = (await deps.users().catch(() => [])).find((u) => u.id === id);
  return user ? userLabel(user) : id;
}

function namesOf(job: Job): string {
  if (job.state.kind !== "awaiting_reply") return "";
  const { from, relay } = job.state;
  const names = from.map((id) => relay.people.find((p) => p.id === id)?.name ?? id);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)} no respondieron` : `${names[0]} no respondió`;
}

/** Relays that waited a day for their reply go back to rest; their owner hears it by DM. Safe to call on every tick. */
export async function expireRelays(deps: Pick<BotDeps, "poster" | "store" | "now">, now = (deps.now ?? Date.now)()): Promise<void> {
  for (const job of dueRelayExpiries(deps.store.data, now)) {
    if (job.state.kind !== "awaiting_reply") continue;
    const { owner, link, dmThread } = job.state.relay;
    const text = `⌛ ${namesOf(job)} en ${link}`;
    if (!commit(deps, job, { kind: "reply_expired" })) continue;
    await deps.poster.dm(owner, text, undefined, dmThread).catch((err) => console.error(`DM to ${owner} failed:`, err));
  }
}
