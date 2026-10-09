import { helpText, parseCommand } from "./commands.ts";
import type { CommandName } from "./commands.ts";
import { isActive, isOtherTask, isResumable, jobId, jobLabel, newJob, sameRepo, targetLabel, transition } from "./jobs.ts";
import type { Job, JobEvent } from "./jobs.ts";
import { worktreePath } from "./orca.ts";
import type { Orca, WorkerStart } from "./orca.ts";
import type { FoundTarget } from "./parse.ts";
import { clearReport, reportPath } from "./report.ts";
import { buildSpec, taskTitle } from "./spec.ts";
import type { StoreHandle } from "./store.ts";

/** The only Slack surface the core needs; Bolt and the console harness both implement it. */
export type Poster = {
  postToThread(job: Pick<Job, "slack">, text: string): Promise<void>;
  react(channel: string, messageTs: string, name: string): Promise<void>;
  /** Starts a new thread in the channel; returns its ts. */
  postTopLevel(channel: string, text: string): Promise<string>;
};

export type BotDeps = {
  orca: Orca;
  poster: Poster;
  store: StoreHandle;
  resolveRepo(owner: string, name: string): Promise<string>;
  latestSession(worktreePath: string): Promise<string | undefined>;
  botUserId?: string;
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
};

export type ThreadReply = { channel: string; threadTs: string; ts: string; text: string };

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

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleMention(deps: BotDeps, m: Mention): Promise<void> {
  switch (m.command) {
    case "aparte":
      return;
    case "ayuda":
      return deps.poster.postToThread(threadOf(m), helpText());
    case "parar":
      return cancel(deps, m);
    case "nuevo":
      if (m.threadTs !== m.ts) return startInNewThread(deps, m);
  }
  const id = jobId(m.channel, m.threadTs);
  const existing = deps.store.data.jobs[id];
  if (existing && m.command !== "nuevo" && m.ownTarget && isOtherTask(existing, m.ownTarget)) {
    if (isActive(existing) && existing.repoSource === "inferred" && !sameRepo(existing, m.ownTarget)) {
      return correctRepo(deps, existing, m, m.ownTarget);
    }
    return replyOtherTask(deps, existing, m.ownTarget);
  }
  if (existing && isActive(existing)) return handleThreadInput(deps, existing, m);
  if (existing && isResumable(existing)) return startFollowUp(deps, existing, m);
  if (starting.has(id)) return;
  return startJob(deps, m);
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
  return startJob(deps, { ...m, threadTs });
}

async function replyOtherTask(deps: BotDeps, job: Job, target: FoundTarget): Promise<void> {
  const how = deps.botUserId ? `escribí <@${deps.botUserId}> \`!nuevo …\`` : "mencioname con `!nuevo …`";
  await deps.poster.postToThread(job, `Este hilo es de ${jobLabel(job)}. Si querés que tome ${targetLabel(target)} como tarea aparte, ${how}.`);
}

/** The user named the right repo after the bot guessed wrong: stop the guess and redo the original request there. */
async function correctRepo(deps: BotDeps, job: Job, m: Mention, target: FoundTarget): Promise<void> {
  if (!job.dispatchId) return handleThreadInput(deps, job, m);
  const label = targetLabel(target);
  try {
    await deps.orca.stopWorker(job.dispatchId);
  } catch (err) {
    console.error(`worker-stop ${job.dispatchId} failed:`, err);
    await deps.poster.postToThread(job, `❌ no pude frenar el worker de ${jobLabel(job)} (${errorText(err)}), así que no arranco otro en ${label}.`);
    return;
  }
  commit(deps, job, { kind: "superseded", reason: `el usuario corrigió el repo a ${label}` });
  await startJob(deps, { ...m, user: job.slack.requester, text: job.request, target }, `🔁 cambio a ${label}.`);
}

function startJob(deps: BotDeps, m: Mention, intro?: string): Promise<void> {
  const id = jobId(m.channel, m.threadTs);
  const p = startJobOnce(deps, m, intro).finally(() => starting.delete(id));
  starting.set(id, p);
  return p;
}

async function startJobOnce(deps: BotDeps, m: Mention, intro?: string): Promise<void> {
  const where = threadOf(m);
  if (!m.target) {
    await deps.poster.postToThread(
      where,
      `<@${m.user}> no encontré qué repo o issue tocar. Pasame el link del issue de GitHub (o \`owner/repo#123\`) en este hilo y mencioname de nuevo.`,
    );
    return;
  }

  const { owner, name, issue, source } = m.target;
  const label = targetLabel(m.target);
  const guessed = source === "inferred" ? " (lo deduje del hilo; si no es ese, mencioname con el repo correcto)" : "";
  await deps.poster.react(m.channel, m.ts, "saluting_face");
  await deps.poster.postToThread(where, intro ?? `🫡 tomo ${issue ? "el issue" : "el pedido en"} ${label}${guessed}. Te aviso por acá.`);
  let orcaRepoId: string;
  try {
    orcaRepoId = await deps.resolveRepo(owner, name);
  } catch (err) {
    await deps.poster.postToThread(where, `❌ <@${m.user}> no pude preparar el repo ${owner}/${name}: ${errorText(err)}`);
    return;
  }
  const job = newJob({ ...where, repo: { owner, name, orcaRepoId }, repoSource: source, issue, request: m.text });
  deps.store.data.jobs[job.id] = job;
  deps.store.save();
  await launch(deps, job, () =>
    deps.orca.startWorker({
      repoId: orcaRepoId,
      name: slug(`${name}-${issue ? `issue-${issue.number}` : "slack"}-${m.threadTs.replace(".", "").slice(-8)}`),
      title: taskTitle(job),
      spec: buildSpec({ job, context: m.context, reportPath: reportPath(job.id) }),
    }),
  );
}

const CANCELLED_SUMMARY = "The user cancelled the previous worker before it finished. Its work so far is whatever is committed or left uncommitted in this worktree.";

async function startFollowUp(deps: BotDeps, job: Job, m: Mention): Promise<void> {
  if (!isResumable(job) || !job.worktreeId) return;
  const previous = job.state.kind === "done" ? job.state : { summary: CANCELLED_SUMMARY, prUrl: undefined };
  const worktreeId = job.worktreeId;
  const next = commit(deps, job, { kind: "follow_up", request: m.text });
  if (!next) return;
  await deps.poster.react(m.channel, m.ts, "saluting_face");
  await deps.poster.postToThread(next, "🫡 sigo sobre el mismo worktree. Te aviso por acá.");
  const title = `${taskTitle(next)} (follow-up)`;
  const report = reportPath(next.id);
  await launch(deps, next, async () => {
    if (next.sessionId) {
      try {
        const spec = buildSpec({ job: next, resumed: true, previousPrUrl: previous.prUrl, reportPath: report });
        const started = await resumeSession(deps, { worktreeId, sessionId: next.sessionId, title, spec });
        console.log(`follow-up ${next.id}: resumed Claude session ${next.sessionId}`);
        return started;
      } catch (err) {
        console.error(`follow-up ${next.id}: resuming session ${next.sessionId} failed, starting a fresh worker:`, err);
      }
    }
    console.log(`follow-up ${next.id}: fresh worker`);
    return deps.orca.startFollowUp({
      worktreeId,
      title,
      spec: buildSpec({ job: next, previousSummary: previous.summary, previousPrUrl: previous.prUrl, reportPath: report }),
    });
  });
}

/** Reopens the previous worker's Claude session in the worktree and hands it the follow-up as a supervised worker. */
async function resumeSession(
  deps: BotDeps,
  opts: { worktreeId: string; sessionId: string; title: string; spec: string },
): Promise<WorkerStart> {
  const handle = await deps.orca.createTerminal({
    worktreeId: opts.worktreeId,
    title: slug(opts.title),
    command: `claude --dangerously-skip-permissions --resume ${opts.sessionId}`,
  });
  try {
    // A long session can take more than a minute to load; one longer retry before giving up.
    const idle = (await deps.orca.waitTuiIdle(handle, 60_000)) || (await deps.orca.waitTuiIdle(handle, 120_000));
    if (!idle) throw new Error(`resumed Claude in ${handle} never became idle`);
    return await deps.orca.startWorkerInTerminal({ worktreeId: opts.worktreeId, handle, title: opts.title, spec: opts.spec });
  } catch (err) {
    await deps.orca.closeTerminal(handle).catch((closeErr) => console.error(`closing terminal ${handle} failed:`, closeErr));
    throw err;
  }
}

async function cancel(deps: BotDeps, m: Mention): Promise<void> {
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
  if (!commit(deps, job, { kind: "cancelled", sessionId })) return;
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
    await clearReport(job.id);
    const w = await start();
    commit(deps, job, { kind: "started", worktreeId: w.worktreeId ?? job.worktreeId ?? "", taskId: w.taskId, dispatchId: w.dispatchId });
  } catch (err) {
    console.error(`worker start failed for ${job.id}:`, err);
    commit(deps, job, { kind: "start_failed", error: errorText(err) });
    await deps.poster.postToThread(job, `❌ <@${job.slack.requester}> no pude arrancar el worker: ${errorText(err)}`);
  }
}

async function handleThreadInput(deps: BotDeps, job: Job, input: { ts: string; text: string; channel: string }): Promise<void> {
  const state = job.state;
  if (state.kind === "awaiting_answer") {
    await deps.orca.reply(state.questionMsgId, input.text);
    commit(deps, job, { kind: "answered" });
    await deps.poster.react(input.channel, input.ts, "white_check_mark");
  } else if (state.kind === "working" && job.dispatchId) {
    await deps.orca.send(job.dispatchId, input.text);
    await deps.poster.react(input.channel, input.ts, "eyes");
  } else if (state.kind === "starting") {
    await deps.poster.postToThread(job, "Todavía estoy arrancando el worker. Mandalo de nuevo en un minuto.");
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
