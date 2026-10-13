import { ROUTE_QUESTION, answeredMessage, plainMessage, routeAskMessage, startMessage } from "./blocks.ts";
import type { Block, Click } from "./blocks.ts";
import { commandMode, helpText, parseCommand, parseRepoArg } from "./commands.ts";
import type { CommandName } from "./commands.ts";
import { mkdir } from "node:fs/promises";
import { downloadFiles, inboxDir, outboxDir, problemsNotice, selectFiles, shownText, withFiles } from "./files.ts";
import type { LocalFile } from "./files.ts";
import { PLAN_OPTIONS, isActive, isOtherTask, isResumable, jobId, jobLabel, newJob, sameRepo, targetLabel, transition } from "./jobs.ts";
import type { Job, JobEvent, Mode, RepoRef } from "./jobs.ts";
import { worktreePath, worktreeSelector } from "./orca.ts";
import type { Orca, WorkerStart } from "./orca.ts";
import { pullTarget } from "./parse.ts";
import type { FoundTarget, KnownRepo } from "./parse.ts";
import { clearReports, planPath, reportPath, slackPost } from "./report.ts";
import { BUTTON_LABELS, decideRoute, routeHint, routeState } from "./route.ts";
import type { AskableRoute, Decision, RouteAnswer, RouteState } from "./route.ts";
import { buildSpec, taskTitle } from "./spec.ts";
import type { StoreHandle } from "./store.ts";

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
};

export type BotDeps = {
  orca: Orca;
  poster: Poster;
  store: StoreHandle;
  resolveRepo(owner: string, name: string): Promise<string>;
  /** GitHub repos Orca already has, for `!repo` and the change-repo picker. */
  knownRepos(): Promise<KnownRepo[]>;
  latestSession(worktreePath: string): Promise<string | undefined>;
  /** Who may start work and click buttons. */
  allowedUsers: ReadonlySet<string>;
  /** Answers a question read-only from a repo checkout, as Markdown. */
  ask(o: { repoPath: string; question: string; thread?: string; files?: readonly LocalFile[] }): Promise<string>;
  botUserId?: string;
  /** Where each job's `in/` and `out/` folders live. */
  filesRoot: string;
  /** A GET of a Slack file URL, authenticated as the bot. */
  fetchFile(url: string): Promise<Response>;
  /** Jev's reading of a plain mention; absent without a TypeSafe key, and then a plain mention is a change. */
  classify?(state: RouteState): Promise<RouteAnswer>;
};

export type Mention = {
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
  text: string;
  context?: string;
  /** The target for a new job, from the mention and its thread. */
  target?: FoundTarget;
  /** A target named deterministically by the mention's own text, never by the thread or Claude. */
  ownTarget?: FoundTarget;
  /** The mention started with this command; `text` is what follows it. */
  command?: CommandName;
  /** Slack file objects of the mention and the thread's earlier human messages. */
  files?: readonly unknown[];
};

export type ThreadReply = { channel: string; threadTs: string; ts: string; user: string; text: string; files?: readonly unknown[] };

/** A validated button or select click, located by the message it came from. */
export type ClickInput = { click: Click; user: string; channel: string; threadTs: string; messageTs: string; context?: string; files?: readonly unknown[] };

/** Thread jobs whose first start is still resolving the repo, before the job exists in the store. */
const starting = new Map<string, Promise<void>>();
const inflightStarts = new Set<Promise<void>>();

/** The inbox waits on this so a question sent before worker-start returns its dispatchId is not dropped as unknown. */
export function startsSettled(): Promise<unknown> {
  return Promise.allSettled([...inflightStarts]);
}

function commit(deps: BotDeps, job: Job, ev: JobEvent): Job | undefined {
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

export async function handleMention(deps: BotDeps, m: Mention): Promise<void> {
  switch (m.command) {
    case "aparte":
      return;
    case "ayuda":
      return deps.poster.postToThread(threadOf(m), helpText());
    case "parar":
      return cancel(deps, m);
    case "pregunta":
      return answer(deps, m);
    case "repo":
      return channelRepo(deps, m);
    case "nuevo":
      if (m.threadTs !== m.ts) return startInNewThread(deps, m);
  }
  const id = jobId(m.channel, m.threadTs);
  const mode = commandMode(m.command);
  const existing = deps.store.data.jobs[id];
  if (existing && m.command !== "nuevo" && m.ownTarget && isOtherTask(existing, m.ownTarget)) {
    if (isActive(existing) && isGuessedRepo(existing) && !sameRepo(existing, m.ownTarget)) {
      return correctRepo(deps, existing, m, m.ownTarget);
    }
    return replyOtherTask(deps, existing, m.ownTarget);
  }
  if (existing && isActive(existing)) return handleThreadInput(deps, existing, m, { onlyFresh: true });
  if (!m.command && deps.classify) return routeMention(deps, m, existing);
  return runMode(deps, m, mode);
}

/** `note` is appended to the start message, to say how a mention without a command was understood. */
function runMode(deps: BotDeps, m: Mention, mode: Mode, note?: string): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  const existing = deps.store.data.jobs[id];
  if (existing && isActive(existing)) return handleThreadInput(deps, existing, m, { onlyFresh: true });
  if (existing && isResumable(existing)) return startFollowUp(deps, existing, m, mode, note);
  if (starting.has(id)) return Promise.resolve();
  return startJob(deps, m, mode, undefined, note);
}

function runRoute(deps: BotDeps, m: Mention, route: AskableRoute, note?: string): Promise<void> {
  return route === "question" ? answer(deps, m, note) : runMode(deps, m, route, note);
}

/** A plain mention: Jev picks the route when it is sure enough for what that route costs, otherwise the human does. */
async function routeMention(deps: BotDeps, m: Mention, job: Job | undefined): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  let decision: Decision;
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
  return runRoute(deps, m, decision.route, routeHint(decision.route));
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

function startJob(deps: BotDeps, m: Mention, mode: Mode, intro?: string, note?: string): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  const p = startJobOnce(deps, m, mode, intro, note).finally(() => starting.delete(id));
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
  const target = mode === "review" && m.target ? pullTarget(m.target, m.text) : m.target;
  if (!target) {
    const missing =
      mode === "review"
        ? "no sé qué PR revisar. Pasame el link del PR (o `owner/repo#123`, o `#123` si el repo ya está claro)"
        : "no encontré qué repo o issue tocar. Pasame el link del issue de GitHub (o `owner/repo#123`)";
    await deps.poster.postToThread(where, `<@${m.user}> ${missing} en este hilo y mencioname de nuevo.`);
    return;
  }

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
  const files = await bringFiles(deps, where, m.files);
  await launch(deps, job, () =>
    deps.orca.startWorker({
      repoId: orcaRepoId,
      name: slug(`${name}-${issue ? `issue-${issue.number}` : "slack"}-${m.threadTs.replace(".", "").slice(-8)}`),
      title: taskTitle(job),
      spec: buildSpec({ job, context: m.context, files, ...runPaths(deps, job.id) }),
    }),
  );
}

const CANCELLED_SUMMARY = "The user cancelled the previous worker before it finished. Its work so far is whatever is committed or left uncommitted in this worktree.";

async function startFollowUp(deps: BotDeps, job: Job, m: Mention, mode: Mode, note?: string): Promise<void> {
  if (!isResumable(job) || !job.worktreeId) return;
  const previous = job.state.kind === "done" ? job.state : { summary: CANCELLED_SUMMARY, prUrl: undefined };
  const worktree = worktreeSelector(job.worktreeId);
  const next = commit(deps, job, { kind: "follow_up", request: m.text, mode });
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
    return deps.orca.startFollowUp({
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
    const repoPath = await deps.orca.repoPath(await deps.resolveRepo(m.target.owner, m.target.name));
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

function knownList(repos: readonly KnownRepo[]): string {
  return repos.length ? `Repos que conozco: ${repos.map((r) => `\`${r.owner}/${r.name}\``).join(", ")}.` : "Orca no tiene repos de GitHub cargados todavía.";
}

async function channelRepo(deps: BotDeps, m: Mention): Promise<void> {
  const repos = await knownReposOrNone(deps);
  const arg = parseRepoArg(m.text, repos);
  const channels = deps.store.data.channels;
  const current = channels[m.channel];
  let text: string;
  switch (arg.kind) {
    case "show":
      text = `${current ? `📌 repo de este canal: ${targetLabel(current)}` : "Este canal no tiene repo por defecto."}\n${knownList(repos)}`;
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
      text = `No reconozco \`${arg.text}\` como repo. Pasame un link de GitHub, \`owner/nombre\` o el nombre exacto de un repo de Orca.\n${knownList(repos)}`;
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
        deps.latestSession(worktreePath(worktreeId)).catch(() => undefined),
        deps.orca.currentBranch(worktreeId).catch(() => undefined),
      ])
    : [];
  if (!(await commitEnding(deps, job, { kind: "cancelled", sessionId }))) return;
  await deps.poster.postToThread(
    job,
    `⏹️ cancelado. El trabajo queda en la rama ${branch ? `\`${branch}\`` : "del worktree"} por si querés retomarlo (mencioname en este hilo).`,
  );
}

function launch(deps: BotDeps, job: Job, start: () => ReturnType<Orca["startWorker"]>): Promise<void> {
  const p = launchOnce(deps, job, start).finally(() => inflightStarts.delete(p));
  inflightStarts.add(p);
  return p;
}

async function launchOnce(deps: BotDeps, job: Job, start: () => ReturnType<Orca["startWorker"]>): Promise<void> {
  try {
    await clearReports(job.id);
    await mkdir(outboxDir(deps.filesRoot, job.id), { recursive: true });
    const w = await start();
    commit(deps, job, { kind: "started", worktreeId: w.worktreeId ?? job.worktreeId ?? "", taskId: w.taskId, dispatchId: w.dispatchId });
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
  if (!job || !isActive(job)) return false;
  await handleThreadInput(deps, job, r);
  return true;
}

/** Jobs a stop or change-repo click is already stopping, so a double click stops once. */
const stopping = new Set<string>();

const STALE = "Ese botón ya no es válido: el hilo siguió de largo.";

/** Buttons run the same paths as typed input. A click on a message the job has moved past changes nothing. */
export async function handleClick(deps: BotDeps, input: ClickInput): Promise<void> {
  const where = { slack: { channel: input.channel, threadTs: input.threadTs, requester: input.user } };
  if (!deps.allowedUsers.has(input.user)) {
    await deps.poster.ephemeral(where, input.user, `Perdón <@${input.user}>, no tengo permiso para trabajar para vos. Pedile al dueño del bot que agregue tu ID \`${input.user}\` a ALLOWED_SLACK_USERS.`);
    return;
  }
  const { click } = input;
  if (click.jobId !== jobId(input.channel, input.threadTs)) return deps.poster.ephemeral(where, input.user, STALE);
  // A start in flight posts its buttons before the job is stored.
  await starting.get(click.jobId);
  const job = deps.store.data.jobs[click.jobId];
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
        const chosen = plainMessage(`${ROUTE_QUESTION}\n✅ <@${input.user}> eligió: ${BUTTON_LABELS[click.route]}`);
        await deps.poster.update(input.channel, input.messageTs, chosen.text, chosen.blocks).catch((err) => console.error(`retiring route buttons in ${click.jobId} failed:`, err));
        await runRoute(deps, pending.mention, click.route);
      }
      break;
    }
  }
  if (!handled) await deps.poster.ephemeral(where, input.user, STALE);
}
