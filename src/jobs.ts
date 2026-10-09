export type JobState =
  | { kind: "starting" }
  | { kind: "working" }
  | { kind: "awaiting_answer"; questionMsgId: string; question: string }
  | { kind: "done"; outcome: "succeeded" | "failed"; summary: string; prUrl?: string }
  | { kind: "failed"; error: string };

export type Job = {
  id: string;
  slack: { channel: string; threadTs: string; requester: string };
  repo: { owner: string; name: string; orcaRepoId: string };
  issue?: { number: number; url: string };
  request: string;
  worktreeId?: string;
  taskId?: string;
  dispatchId?: string;
  state: JobState;
};

export type Store = { runId?: string; jobs: Record<string, Job>; processedMsgIds: string[] };

export type JobEvent =
  | { kind: "started"; worktreeId: string; taskId: string; dispatchId: string }
  | { kind: "start_failed"; error: string }
  | { kind: "question"; msgId: string; question: string }
  | { kind: "answered" }
  | { kind: "worker_done"; outcome: "succeeded" | "failed"; summary: string; prUrl?: string }
  | { kind: "follow_up"; request: string };

export function jobId(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function newJob(fields: Omit<Job, "id" | "state">): Job {
  return { ...fields, id: jobId(fields.slack.channel, fields.slack.threadTs), state: { kind: "starting" } };
}

export function isActive(job: Job): boolean {
  const k = job.state.kind;
  return k === "starting" || k === "working" || k === "awaiting_answer";
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
      return { ...job, state: { kind: "awaiting_answer", questionMsgId: ev.msgId, question: ev.question } };
    case "answered":
      if (from !== "awaiting_answer") return undefined;
      return { ...job, state: { kind: "working" } };
    case "worker_done":
      if (!isActive(job)) return undefined;
      return { ...job, state: { kind: "done", outcome: ev.outcome, summary: ev.summary, prUrl: ev.prUrl } };
    case "follow_up":
      if (from !== "done") return undefined;
      return { ...job, request: ev.request, taskId: undefined, dispatchId: undefined, state: { kind: "starting" } };
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

export type InboxOutcome = { job: Job; post?: string; release?: string };

/**
 * Decides what one orchestration message means for its Job. Pure: the caller posts,
 * releases, then commits `job` and marks the message processed.
 */
export function applyInboxMessage(store: Store, msg: InboxMessage, prUrlFallback?: string, report?: string): InboxOutcome | undefined {
  if (store.processedMsgIds.includes(msg.id)) return undefined;
  const payload = parsePayload(msg);
  const job = findJobByDispatch(store, payload.dispatchId);
  if (!job) return undefined;
  const who = `<@${job.slack.requester}>`;

  switch (msg.type) {
    case "question": {
      const question = payload.question ?? msg.body ?? msg.subject ?? "";
      const next = transition(job, { kind: "question", msgId: msg.id, question });
      if (!next) return undefined;
      const options = Array.isArray(payload.options) && payload.options.length ? `\nOpciones: ${payload.options.join(" / ")}` : "";
      return { job: next, post: `${who} pregunta: ${question}${options}\n_Respondé en este hilo._` };
    }
    case "escalation":
      return { job, post: `⚠️ ${who} el worker escaló: ${msg.subject ?? ""}\n${msg.body ?? ""}`.trim() };
    case "worker_done": {
      const outcome = payload.outcome === "succeeded" ? "succeeded" : "failed";
      const summary = report ?? summaryOf(msg);
      const prUrl = extractPrUrl(msg.body ?? "") ?? extractPrUrl(report ?? "") ?? prUrlFallback;
      const next = transition(job, { kind: "worker_done", outcome, summary, prUrl });
      if (!next) return undefined;
      const head = outcome === "succeeded" ? `✅ ${who} terminé.` : `❌ ${who} no pude completarlo.`;
      const pr = prUrl ? `*PR:* ${prUrl}` : "No se abrió PR.";
      return { job: next, post: `${head}\n\n${summary}\n\n${pr}`, release: payload.dispatchId };
    }
    default:
      return undefined;
  }
}

export function markProcessed(store: Store, msgId: string): void {
  store.processedMsgIds.push(msgId);
  if (store.processedMsgIds.length > 1000) store.processedMsgIds.splice(0, store.processedMsgIds.length - 1000);
}
