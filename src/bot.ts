import { isActive, jobId, newJob, transition } from "./jobs.ts";
import type { Job, JobEvent } from "./jobs.ts";
import type { Orca } from "./orca.ts";
import type { GithubTarget } from "./parse.ts";
import { clearReport, reportPath } from "./report.ts";
import { buildSpec, taskTitle } from "./spec.ts";
import type { StoreHandle } from "./store.ts";

/** The only Slack surface the core needs; Bolt and the console harness both implement it. */
export type Poster = {
  postToThread(job: Pick<Job, "slack">, text: string): Promise<void>;
  react(channel: string, messageTs: string, name: string): Promise<void>;
};

export type BotDeps = {
  orca: Orca;
  poster: Poster;
  store: StoreHandle;
  resolveRepo(owner: string, name: string): Promise<string>;
};

export type Mention = {
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
  text: string;
  context?: string;
  target?: GithubTarget;
};

export type ThreadReply = { channel: string; threadTs: string; ts: string; text: string };

const starting = new Set<string>();
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
  const id = jobId(m.channel, m.threadTs);
  const existing = deps.store.data.jobs[id];
  if (existing && isActive(existing)) return handleThreadInput(deps, existing, m);
  if (existing?.state.kind === "done" && existing.worktreeId) return startFollowUp(deps, existing, m);
  if (starting.has(id)) return;

  const where = { slack: { channel: m.channel, threadTs: m.threadTs, requester: m.user } };
  if (!m.target) {
    await deps.poster.postToThread(
      where,
      `<@${m.user}> no encontré qué repo o issue tocar. Pasame el link del issue de GitHub (o \`owner/repo#123\`) en este hilo y mencioname de nuevo.`,
    );
    return;
  }

  const { owner, name, issue } = m.target;
  const label = issue ? `${owner}/${name}#${issue.number}` : `${owner}/${name}`;
  starting.add(id);
  try {
    await deps.poster.react(m.channel, m.ts, "saluting_face");
    await deps.poster.postToThread(where, `🫡 tomo ${issue ? "el issue" : "el pedido en"} ${label}. Te aviso por acá.`);
    let orcaRepoId: string;
    try {
      orcaRepoId = await deps.resolveRepo(owner, name);
    } catch (err) {
      await deps.poster.postToThread(where, `❌ <@${m.user}> no pude preparar el repo ${owner}/${name}: ${errorText(err)}`);
      return;
    }
    const job = newJob({ ...where, repo: { owner, name, orcaRepoId }, issue, request: m.text });
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
  } finally {
    starting.delete(id);
  }
}

async function startFollowUp(deps: BotDeps, job: Job, m: Mention): Promise<void> {
  if (job.state.kind !== "done" || !job.worktreeId) return;
  const previous = job.state;
  const worktreeId = job.worktreeId;
  const next = commit(deps, job, { kind: "follow_up", request: m.text });
  if (!next) return;
  await deps.poster.react(m.channel, m.ts, "saluting_face");
  await deps.poster.postToThread(next, "🫡 sigo sobre el mismo worktree. Te aviso por acá.");
  await launch(deps, next, () =>
    deps.orca.startFollowUp({
      worktreeId,
      title: `${taskTitle(next)} (follow-up)`,
      spec: buildSpec({ job: next, previousSummary: previous.summary, previousPrUrl: previous.prUrl, reportPath: reportPath(next.id) }),
    }),
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

/** Plain thread replies (no mention). Returns false when the thread has no active job. */
export async function handleThreadReply(deps: BotDeps, r: ThreadReply): Promise<boolean> {
  const job = deps.store.data.jobs[jobId(r.channel, r.threadTs)];
  if (!job || !isActive(job)) return false;
  await handleThreadInput(deps, job, r);
  return true;
}
