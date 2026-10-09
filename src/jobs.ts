import { questionMessage } from "./blocks.ts";
import type { Block } from "./blocks.ts";

export type JobState =
  | { kind: "starting" }
  | { kind: "working" }
  | {
      kind: "awaiting_answer";
      questionMsgId: string;
      question: string;
      options: string[];
      /** The Slack message holding the option buttons, retired once the question is answered. */
      postTs?: string;
    }
  | { kind: "done"; outcome: "succeeded" | "failed"; summary: string; prUrl?: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

/** How the repo was found: a GitHub link or `owner/repo#n`, an exact known repo name, the channel's `!repo` default, or Claude's guess from the thread. */
export type RepoSource = "link" | "name" | "channel" | "inferred";

export type RepoRef = { owner: string; name: string };

export type Job = {
  id: string;
  slack: { channel: string; threadTs: string; requester: string };
  repo: { owner: string; name: string; orcaRepoId: string };
  repoSource?: RepoSource;
  issue?: { number: number; url: string };
  request: string;
  worktreeId?: string;
  taskId?: string;
  dispatchId?: string;
  /** The last worker's Claude session, resumed by the next follow-up. */
  sessionId?: string;
  /** The message announcing the current worker, whose buttons are retired when the job leaves the active states. */
  startMsg?: { ts: string; text: string };
  /** Last ⏳ post time (ms) and the newest status held back because it came too soon after it. */
  progress?: { postedAt: number; pending?: string };
  state: JobState;
};

export type Store = {
  runId?: string;
  jobs: Record<string, Job>;
  processedMsgIds: string[];
  /** Each channel's `!repo` default. */
  channels: Record<string, RepoRef>;
};

export type JobEvent =
  | { kind: "started"; worktreeId: string; taskId: string; dispatchId: string }
  | { kind: "start_failed"; error: string }
  | { kind: "question"; msgId: string; question: string; options: string[] }
  | { kind: "question_posted"; msgId: string; ts: string }
  | { kind: "answered" }
  | { kind: "worker_done"; outcome: "succeeded" | "failed"; summary: string; prUrl?: string; sessionId?: string }
  | { kind: "cancelled"; sessionId?: string }
  | { kind: "follow_up"; request: string }
  | { kind: "superseded"; reason: string };

export function jobId(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function newJob(fields: Omit<Job, "id" | "state">): Job {
  return { ...fields, id: jobId(fields.slack.channel, fields.slack.threadTs), state: { kind: "starting" } };
}

export function jobLabel(job: Pick<Job, "repo" | "issue">): string {
  return targetLabel({ ...job.repo, issue: job.issue });
}

export function targetLabel(t: { owner: string; name: string; issue?: { number: number } }): string {
  return t.issue ? `${t.owner}/${t.name}#${t.issue.number}` : `${t.owner}/${t.name}`;
}

export function sameRepo(job: Pick<Job, "repo">, t: { owner: string; name: string }): boolean {
  return job.repo.owner.toLowerCase() === t.owner.toLowerCase() && job.repo.name.toLowerCase() === t.name.toLowerCase();
}

/** A target that is not this job's work: another repo, or an issue other than the job's. */
export function isOtherTask(job: Pick<Job, "repo" | "issue">, t: { owner: string; name: string; issue?: { number: number } }): boolean {
  return !sameRepo(job, t) || (t.issue !== undefined && t.issue.number !== job.issue?.number);
}

export function isActive(job: Job): boolean {
  const k = job.state.kind;
  return k === "starting" || k === "working" || k === "awaiting_answer";
}

/** A finished or cancelled job whose worktree a later mention continues. */
export function isResumable(job: Job): boolean {
  return (job.state.kind === "done" || job.state.kind === "cancelled") && job.worktreeId !== undefined;
}

/** Returns undefined when the event does not apply to the job's current state. */
export function transition(job: Job, ev: JobEvent): Job | undefined {
  const from = job.state.kind;
  switch (ev.kind) {
    case "started":
      if (from !== "starting") return undefined;
      return {
        ...job,
        worktreeId: ev.worktreeId,
        taskId: ev.taskId,
        dispatchId: ev.dispatchId,
        state: { kind: "working" },
      };
    case "start_failed":
      if (from !== "starting") return undefined;
      return { ...job, state: { kind: "failed", error: ev.error } };
    case "question":
      if (from !== "working" && from !== "awaiting_answer") return undefined;
      return { ...job, state: { kind: "awaiting_answer", questionMsgId: ev.msgId, question: ev.question, options: ev.options } };
    case "question_posted":
      if (job.state.kind !== "awaiting_answer" || job.state.questionMsgId !== ev.msgId) return undefined;
      return { ...job, state: { ...job.state, postTs: ev.ts } };
    case "answered":
      if (from !== "awaiting_answer") return undefined;
      return { ...job, state: { kind: "working" } };
    case "worker_done":
      if (!isActive(job)) return undefined;
      return {
        ...job,
        sessionId: ev.sessionId ?? job.sessionId,
        state: { kind: "done", outcome: ev.outcome, summary: ev.summary, prUrl: ev.prUrl },
      };
    case "cancelled":
      if (!isActive(job)) return undefined;
      return { ...job, sessionId: ev.sessionId ?? job.sessionId, state: { kind: "cancelled" } };
    case "follow_up":
      if (from !== "done" && from !== "cancelled") return undefined;
      return { ...job, request: ev.request, taskId: undefined, dispatchId: undefined, progress: undefined, startMsg: undefined, state: { kind: "starting" } };
    case "superseded":
      if (!isActive(job)) return undefined;
      return { ...job, state: { kind: "failed", error: ev.reason } };
  }
}

export type InboxMessage = { id: string; type: string; subject?: string; body?: string; payload?: unknown };

type Payload = { dispatchId?: string; question?: string; options?: unknown; outcome?: string };

export function parsePayload(msg: InboxMessage): Payload {
  if (typeof msg.payload === "string") {
    try {
      return JSON.parse(msg.payload) as Payload;
    } catch {
      return {};
    }
  }
  return (msg.payload as Payload | null) ?? {};
}

export function findJobByDispatch(store: Store, dispatchId: string | undefined): Job | undefined {
  if (!dispatchId) return undefined;
  return Object.values(store.jobs).find((j) => j.dispatchId === dispatchId);
}

const PR_URL = /https:\/\/github\.com\/[^\s)>|]+\/pull\/\d+/;

export function extractPrUrl(text: string): string | undefined {
  return PR_URL.exec(text)?.[0];
}

const MAX_SUMMARY = 3000;

function summaryOf(msg: InboxMessage): string {
  const body = (msg.body ?? msg.subject ?? "").replace(/^\s*PR:\s*\S+\s*$/gm, "").trim();
  return body.length > MAX_SUMMARY ? `${body.slice(0, MAX_SUMMARY)}…` : body;
}

export type InboxOutcome = { job: Job; post?: string; blocks?: Block[]; release?: string };

/** What the caller read from disk or GitHub for a worker_done; ignored for other messages. */
export type DoneExtras = { prUrlFallback?: string; report?: string; sessionId?: string };

/**
 * Decides what one orchestration message means for its Job. Pure: the caller posts,
 * releases, then commits `job` and marks the message processed.
 */
export function applyInboxMessage(store: Store, msg: InboxMessage, extras: DoneExtras = {}, now = Date.now()): InboxOutcome | undefined {
  if (store.processedMsgIds.includes(msg.id)) return undefined;
  const payload = parsePayload(msg);
  const job = findJobByDispatch(store, payload.dispatchId);
  if (!job) return undefined;
  const who = `<@${job.slack.requester}>`;

  switch (msg.type) {
    case "question": {
      const question = payload.question ?? msg.body ?? msg.subject ?? "";
      const options = Array.isArray(payload.options) ? payload.options.map(String).filter((o) => o.trim()) : [];
      const next = transition(job, { kind: "question", msgId: msg.id, question, options });
      if (!next) return undefined;
      const { text, blocks } = questionMessage({ jobId: job.id, questionMsgId: msg.id, requester: job.slack.requester, question, options });
      return { job: next, post: text, blocks };
    }
    case "status": {
      if (!isActive(job)) return undefined;
      const text = (msg.body ?? msg.subject ?? "").trim();
      if (!text) return undefined;
      return progressUpdate(job, text.length > MAX_STATUS ? `${text.slice(0, MAX_STATUS)}…` : text, now);
    }
    case "escalation":
      return { job, post: `⚠️ ${who} el worker escaló: ${msg.subject ?? ""}\n${msg.body ?? ""}`.trim() };
    case "worker_done": {
      // The user stopped this dispatch; its late report is not news, but the worker still needs releasing.
      if (job.state.kind === "cancelled") return { job, release: payload.dispatchId };
      const outcome = payload.outcome === "succeeded" ? "succeeded" : "failed";
      const { report, sessionId } = extras;
      const summary = report ?? summaryOf(msg);
      const prUrl = extractPrUrl(msg.body ?? "") ?? extractPrUrl(report ?? "") ?? extras.prUrlFallback;
      const next = transition(job, { kind: "worker_done", outcome, summary, prUrl, sessionId });
      if (!next) return undefined;
      const head = outcome === "succeeded" ? `✅ ${who} terminé.` : `❌ ${who} no pude completarlo.`;
      const pr = prUrl ? `*PR:* ${prUrl}` : "No se abrió PR.";
      return { job: next, post: `${head}\n\n${summary}\n\n${pr}`, release: payload.dispatchId };
    }
    default:
      return undefined;
  }
}

const MAX_STATUS = 300;
export const PROGRESS_INTERVAL_MS = 60_000;

function progressUpdate(job: Job, text: string, now: number): InboxOutcome {
  if (job.progress && now - job.progress.postedAt < PROGRESS_INTERVAL_MS) {
    return { job: { ...job, progress: { ...job.progress, pending: text } } };
  }
  return { job: { ...job, progress: { postedAt: now } }, post: `⏳ ${text}` };
}

/** Held-back statuses of active jobs whose interval has passed, ready to post. */
export function dueProgress(store: Store, now: number): InboxOutcome[] {
  return Object.values(store.jobs).flatMap((job) => {
    const pending = job.progress?.pending;
    if (!pending || !isActive(job) || now - job.progress!.postedAt < PROGRESS_INTERVAL_MS) return [];
    return [{ job: { ...job, progress: { postedAt: now } }, post: `⏳ ${pending}` }];
  });
}

/** Milliseconds until the next held-back status may post, or undefined when none is waiting. */
export function nextProgressIn(store: Store, now: number): number | undefined {
  const waits = Object.values(store.jobs)
    .filter((job) => job.progress?.pending && isActive(job))
    .map((job) => Math.max(0, job.progress!.postedAt + PROGRESS_INTERVAL_MS - now));
  return waits.length ? Math.min(...waits) : undefined;
}

export function markProcessed(store: Store, msgId: string): void {
  store.processedMsgIds.push(msgId);
  if (store.processedMsgIds.length > 1000) store.processedMsgIds.splice(0, store.processedMsgIds.length - 1000);
}
