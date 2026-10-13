import { createHash } from "node:crypto";
import { MESSAGE_MAX, doneMessage, planMessage, questionMessage } from "./blocks.ts";
import type { Block, Message } from "./blocks.ts";
import type { Approval } from "./approvals.ts";
import type { Mention } from "./bot.ts";
import { digestText, parseRelayFile } from "./relay.ts";
import type { UnknownName } from "./relay.ts";
import { slackPost } from "./report.ts";

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
  | Settled
  | { kind: "failed"; error: string }
  /** The worker carries out an owner's private instruction; nothing but its own message reaches the thread. */
  | { kind: "relaying"; relay: Relay; step: RelayStep }
  /** The relay's message is in the thread and waits for the first reply from `from`, then the worker digests it. */
  | { kind: "awaiting_reply"; relay: Relay; from: string[]; postTs: string; since: number };

/** Where a job rests between runs: what the next follow-up continues from. */
export type Settled = { kind: "done"; outcome: "succeeded" | "failed"; summary: string; prUrl?: string } | { kind: "cancelled" };

export type Person = { id: string; name: string };

/** An owner's private instruction for a thread, and the state the job returns to once it is carried out. */
/** `dmThread` is the root ts of the owner's DM thread, where every answer about this relay goes, also a day later. */
export type Relay = { owner: string; dmThread: string; instruction: string; people: Person[]; unknown: UnknownName[]; link: string; after: Settled };

/** First the worker writes the thread message; then, if a reply came, a private digest of it for the owner. */
export type RelayStep = { kind: "write" } | { kind: "digest"; from: Person; reply: string };

export const RELAY_REPLY_TTL_MS = 24 * 60 * 60 * 1000;

/** How the repo was found: a GitHub link or `owner/repo#n`, an exact known repo name, the channel's `!repo` default, or Claude's guess from the thread. */
export type RepoSource = "link" | "name" | "channel" | "inferred";

export type RepoRef = { owner: string; name: string };

/** What a worker run delivers: a PR, a cited report with no PR, a PR after the human approves a plan, or a read-only review of an existing PR. */
export type Mode = "change" | "investigate" | "plan" | "review";

/** Modes whose worker never commits, pushes or opens a PR. */
export function isReadOnly(mode: Mode): boolean {
  return mode === "investigate" || mode === "review";
}

/** The options of a plan-mode approval question. `Cambiar` asks the human to type the change. */
export const PLAN_OPTIONS = { approve: "Aprobar", change: "Cambiar" } as const;

export type Job = {
  id: string;
  slack: { channel: string; threadTs: string; requester: string };
  repo: { owner: string; name: string; orcaRepoId: string };
  repoSource?: RepoSource;
  issue?: { number: number; url: string };
  request: string;
  /** The current run's mode; each follow-up picks its own. */
  mode: Mode;
  /** Hash of the plan file last posted to the thread, so an unchanged plan is not posted again. */
  planHash?: string;
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
  /** Per thread, the mention whose route the bot asked the human to pick, and the message holding the buttons. */
  pendingRoutes: Record<string, { ts: string; mention: Mention }>;
  /** Teammates' requests by `approvalId`, pending or decided. */
  approvals: Record<string, Approval>;
  /** Per owner, the job of the thread their last DM was about; a top-level DM without a link goes there. */
  lastThreadByOwner: Record<string, string>;
  /** Per DM thread (`<dm channel>:<root ts>`), the job it is about; a DM written inside that thread goes there. */
  jobByDmThread: Record<string, string>;
};

export type JobEvent =
  | { kind: "started"; worktreeId: string; taskId: string; dispatchId: string }
  | { kind: "start_failed"; error: string }
  | { kind: "question"; msgId: string; question: string; options: string[] }
  | { kind: "question_posted"; msgId: string; ts: string }
  | { kind: "answered" }
  | { kind: "worker_done"; outcome: "succeeded" | "failed"; summary: string; prUrl?: string; sessionId?: string }
  | { kind: "cancelled"; sessionId?: string }
  | { kind: "follow_up"; request: string; mode: Mode; requester: string }
  | { kind: "superseded"; reason: string }
  | { kind: "relay"; relay: Omit<Relay, "after"> }
  | { kind: "relay_posted"; ts: string; at: number; awaiting: string[] }
  | { kind: "relay_reply"; from: Person; text: string }
  | { kind: "relay_ended"; sessionId?: string }
  | { kind: "reply_expired" };

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
  return k === "starting" || k === "working" || k === "awaiting_answer" || k === "relaying";
}

/** The thread's last finished or cancelled run, which an owner's relay leaves as it was. */
export function lastRun(job: Job): Settled | undefined {
  const s = job.state;
  if (s.kind === "done" || s.kind === "cancelled") return s;
  return s.kind === "relaying" || s.kind === "awaiting_reply" ? s.relay.after : undefined;
}

/** A finished or cancelled job whose worktree a later mention continues, also while a relay waits for its reply. */
export function isResumable(job: Job): boolean {
  return !isActive(job) && lastRun(job) !== undefined && job.worktreeId !== undefined;
}

/** A new run on the same worktree starts with no dispatch, progress or start message of the last one. */
const fresh = { taskId: undefined, dispatchId: undefined, progress: undefined, startMsg: undefined };

/** Returns undefined when the event does not apply to the job's current state. */
export function transition(job: Job, ev: JobEvent): Job | undefined {
  const from = job.state.kind;
  switch (ev.kind) {
    case "started":
      if (from === "relaying" && !job.dispatchId) return { ...job, taskId: ev.taskId, dispatchId: ev.dispatchId };
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
      if (!isActive(job) || from === "relaying") return undefined;
      return {
        ...job,
        sessionId: ev.sessionId ?? job.sessionId,
        state: { kind: "done", outcome: ev.outcome, summary: ev.summary, prUrl: ev.prUrl },
      };
    case "cancelled":
      if (!isActive(job)) return undefined;
      // A stopped relay leaves the thread's own work as it was.
      if (job.state.kind === "relaying") return { ...job, sessionId: ev.sessionId ?? job.sessionId, state: job.state.relay.after };
      return { ...job, sessionId: ev.sessionId ?? job.sessionId, state: { kind: "cancelled" } };
    case "follow_up":
      if (isActive(job) || !lastRun(job)) return undefined;
      return {
        ...job,
        ...fresh,
        slack: { ...job.slack, requester: ev.requester },
        request: ev.request,
        mode: ev.mode,
        planHash: undefined,
        state: { kind: "starting" },
      };
    case "superseded":
      if (!isActive(job)) return undefined;
      return { ...job, state: { kind: "failed", error: ev.reason } };
    case "relay": {
      const after = lastRun(job);
      if (isActive(job) || !after) return undefined;
      return { ...job, ...fresh, state: { kind: "relaying", relay: { ...ev.relay, after }, step: { kind: "write" } } };
    }
    case "relay_posted": {
      const s = job.state;
      if (s.kind !== "relaying" || s.step.kind !== "write") return undefined;
      if (!ev.awaiting.length) return { ...job, ...fresh, state: s.relay.after };
      return { ...job, ...fresh, state: { kind: "awaiting_reply", relay: s.relay, from: ev.awaiting, postTs: ev.ts, since: ev.at } };
    }
    case "relay_reply":
      if (job.state.kind !== "awaiting_reply") return undefined;
      return { ...job, ...fresh, state: { kind: "relaying", relay: job.state.relay, step: { kind: "digest", from: ev.from, reply: ev.text } } };
    case "relay_ended":
      if (job.state.kind !== "relaying") return undefined;
      return { ...job, ...fresh, sessionId: ev.sessionId ?? job.sessionId, state: job.state.relay.after };
    case "reply_expired":
      if (job.state.kind !== "awaiting_reply") return undefined;
      return { ...job, ...fresh, state: job.state.relay.after };
  }
}

/** Relays whose message has waited a day for its reply. */
export function dueRelayExpiries(store: Store, now: number): Job[] {
  return Object.values(store.jobs).filter((j) => j.state.kind === "awaiting_reply" && now - j.state.since >= RELAY_REPLY_TTL_MS);
}

/** Whether `user`'s reply at `ts` is the one an awaiting relay waits for; owners may answer in their stead. */
export function awaitsReply(job: Job, user: string, ts: string, isOwner: boolean): boolean {
  const s = job.state;
  return s.kind === "awaiting_reply" && (s.from.includes(user) || isOwner) && Number(ts) > Number(s.postTs);
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

function summaryOf(msg: InboxMessage): string {
  const body = (msg.body ?? msg.subject ?? "").replace(/^\s*PR:\s*\S+\s*$/gm, "").trim();
  return body.length > MESSAGE_MAX ? `${body.slice(0, MESSAGE_MAX)}…` : body;
}

/**
 * `lead` is posted before `post`, as its own message. `dm` goes privately to an owner.
 * `relayPosted` asks the caller to record the posted relay message's ts; `answer` replies to a worker's question.
 */
export type InboxOutcome = {
  job: Job;
  lead?: Message;
  post?: string;
  blocks?: Block[];
  release?: string;
  dm?: { user: string; text: string; threadTs?: string };
  relayPosted?: { awaiting: string[] };
  answer?: { msgId: string; text: string };
};

/** What the caller read from disk or GitHub: the plan for a plan-mode question, the rest for a worker_done. */
export type Extras = { prUrlFallback?: string; report?: string; sessionId?: string; plan?: string; relayFile?: string };

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The PR a review looked at: the job's own target when it is a pull request, else the one the worker reported. */
function reviewedPr(job: Job, prUrl: string | undefined): string | undefined {
  return job.issue?.url.includes("/pull/") ? job.issue.url : prUrl;
}

function prLabel(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
}

function doneMessageFor(job: Job, outcome: "succeeded" | "failed", summary: string, prUrl: string | undefined): Message {
  const who = `<@${job.slack.requester}>`;
  const failed = `❌ ${who} no pude completarlo.`;
  switch (job.mode) {
    case "review": {
      const pr = reviewedPr(job, prUrl);
      return doneMessage(`${outcome === "failed" ? failed : `🔍 ${who} revisé ${pr ? prLabel(pr) : jobLabel(job)}.`}\n\n${summary}`, pr);
    }
    // An investigation's PR, if the thread has one from an earlier run, stays recorded for the next follow-up but is not this run's news.
    case "investigate":
      return doneMessage(`${outcome === "failed" ? failed : `🔎 ${who} listo.`}\n\n${summary}`);
    case "change":
    case "plan":
      if (outcome === "failed") return doneMessage(`${failed}\n\n${summary}\n\n${prUrl ? `*PR:* ${prUrl}` : "No se abrió PR."}`, prUrl);
      // A change that turned out to need no code (a review or a question) succeeds without a PR.
      if (!prUrl) return doneMessage(`✅ ${who} listo.\n\n${summary}`);
      return doneMessage(`✅ ${who} terminé.\n\n${summary}\n\n*PR:* ${prUrl}`, prUrl);
  }
}

/**
 * Decides what one orchestration message means for its Job. Pure: the caller posts,
 * releases, then commits `job` and marks the message processed.
 */
export function applyInboxMessage(store: Store, msg: InboxMessage, extras: Extras = {}, now = Date.now()): InboxOutcome | undefined {
  if (store.processedMsgIds.includes(msg.id)) return undefined;
  const payload = parsePayload(msg);
  const job = findJobByDispatch(store, payload.dispatchId);
  if (!job) return undefined;
  if (job.state.kind === "relaying") return relayOutcome(job, job.state, msg, payload, extras);
  const who = `<@${job.slack.requester}>`;

  switch (msg.type) {
    case "question": {
      const question = payload.question ?? msg.body ?? msg.subject ?? "";
      const options = Array.isArray(payload.options) ? payload.options.map(String).filter((o) => o.trim()) : [];
      const next = transition(job, { kind: "question", msgId: msg.id, question, options });
      if (!next) return undefined;
      const { text, blocks } = questionMessage({ jobId: job.id, questionMsgId: msg.id, requester: job.slack.requester, question, options });
      const planHash = job.mode === "plan" && extras.plan ? hash(extras.plan) : undefined;
      if (!planHash || planHash === job.planHash) return { job: next, post: text, blocks };
      return { job: { ...next, planHash }, lead: planMessage(extras.plan!), post: text, blocks };
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
      const { text, blocks } = doneMessageFor(job, outcome, summary, prUrl);
      return { job: next, post: text, blocks, release: payload.dispatchId };
    }
    default:
      return undefined;
  }
}

const NO_HUMAN = "No human can answer during this step. Decide on your own, and carry on.";

/** A relay run speaks only through its file: its statuses are dropped, its questions answered here, its failures DMed. */
function relayOutcome(
  job: Job,
  state: Extract<JobState, { kind: "relaying" }>,
  msg: InboxMessage,
  payload: Payload,
  extras: Extras,
): InboxOutcome | undefined {
  const { relay, step } = state;
  const where = `en ${relay.link}`;
  const ended = (sessionId?: string) => transition(job, { kind: "relay_ended", sessionId })!;
  switch (msg.type) {
    case "question":
      return { job, answer: { msgId: msg.id, text: NO_HUMAN } };
    case "escalation":
      return { job, dm: { user: relay.owner, threadTs: relay.dmThread, text: `⚠️ el worker escaló ${where}: ${msg.subject ?? ""}\n${msg.body ?? ""}`.trim() } };
    case "worker_done": {
      const release = payload.dispatchId;
      const sessionId = extras.sessionId;
      const fail = (why: string) => ({ job: ended(sessionId), release, dm: { user: relay.owner, threadTs: relay.dmThread, text: `❌ no pude ${step.kind === "write" ? "escribir" : "resumir la respuesta"} ${where}: ${why}` } });
      if (payload.outcome !== "succeeded") return fail(summaryOf(msg) || "el worker terminó sin éxito.");
      if (!extras.relayFile) return fail("el worker no dejó el archivo con el mensaje.");
      if (step.kind === "digest") {
        return { job: ended(sessionId), release, dm: { user: relay.owner, threadTs: relay.dmThread, text: `💬 ${step.from.name} respondió ${where}:\n\n${slackPost(digestText(extras.relayFile))}` } };
      }
      const parsed = parseRelayFile(extras.relayFile, { people: relay.people.map((p) => p.id), unknown: relay.unknown, owner: relay.owner });
      if ("error" in parsed) return fail(parsed.error);
      if (parsed.kind === "private") return { job: ended(sessionId), release, dm: { user: relay.owner, threadTs: relay.dmThread, text: `💬 ${where}:\n\n${slackPost(parsed.text)}` } };
      return { job: { ...job, sessionId: sessionId ?? job.sessionId }, post: slackPost(parsed.text), release, relayPosted: { awaiting: parsed.awaiting } };
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
