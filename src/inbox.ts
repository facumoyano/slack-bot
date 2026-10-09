import { setTimeout as sleep } from "node:timers/promises";
import { applyInboxMessage, dueProgress, extractPrUrl, findJobByDispatch, markProcessed, nextProgressIn, parsePayload, transition } from "./jobs.ts";
import type { InboxMessage, InboxOutcome, Job } from "./jobs.ts";
import { startsSettled } from "./bot.ts";
import { readReport, slackPost } from "./report.ts";
import type { Poster } from "./bot.ts";
import { worktreePath } from "./orca.ts";
import type { Orca } from "./orca.ts";
import type { StoreHandle } from "./store.ts";

export type InboxDeps = {
  orca: Pick<Orca, "checkInbox" | "release" | "lookupPrUrl">;
  poster: Poster;
  store: StoreHandle;
  latestSession(worktreePath: string): Promise<string | undefined>;
  now?(): number;
};

async function prFallback(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done" || extractPrUrl(msg.body ?? "")) return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  if (!job?.worktreeId) return undefined;
  return deps.orca.lookupPrUrl(job.worktreeId, job.repo.owner, job.repo.name);
}

async function renderedReport(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done") return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  const report = job && (await readReport(job.id));
  if (!report) return undefined;
  return slackPost(report.replace(/^\s*\**PR:?\**:?\s*\S+\s*$/gim, "").trim());
}

async function sessionOf(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done") return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  if (!job?.worktreeId) return undefined;
  return deps.latestSession(worktreePath(job.worktreeId)).catch((err) => {
    console.error(`session lookup for ${job.id} failed:`, err);
    return undefined;
  });
}

/** Commits an outcome unless a mention changed the job (a cancel, a follow-up) while it was being posted. */
function commitOutcome(deps: InboxDeps, before: Job | undefined, outcome: InboxOutcome): void {
  if (deps.store.data.jobs[outcome.job.id] === before) deps.store.data.jobs[outcome.job.id] = outcome.job;
}

/**
 * Post first, then record the message as processed, so a crash re-posts at most once and never drops.
 * Every call, even with no messages, also posts held-back statuses whose interval has passed.
 */
export async function processBatch(deps: InboxDeps, messages: readonly InboxMessage[]): Promise<void> {
  const now = deps.now ?? Date.now;
  const data = deps.store.data;
  for (const msg of messages) {
    if (data.processedMsgIds.includes(msg.id)) continue;
    const extras = {
      prUrlFallback: await prFallback(deps, msg),
      report: await renderedReport(deps, msg),
      sessionId: await sessionOf(deps, msg),
    };
    const before = findJobByDispatch(data, parsePayload(msg).dispatchId);
    const outcome = applyInboxMessage(data, msg, extras, now());
    if (outcome?.post) {
      const ts = await deps.poster.postToThread(outcome.job, outcome.post, outcome.blocks);
      if (outcome.blocks && msg.type === "question") outcome.job = transition(outcome.job, { kind: "question_posted", msgId: msg.id, ts }) ?? outcome.job;
    }
    if (outcome) commitOutcome(deps, before, outcome);
    markProcessed(data, msg.id);
    deps.store.save();
    if (outcome?.release) {
      await deps.orca.release(outcome.release).catch((err) => console.error(`worker-release ${outcome.release} failed:`, err));
    }
  }
  for (const [before, outcome] of dueProgress(data, now()).map((o) => [data.jobs[o.job.id], o] as const)) {
    await deps.poster.postToThread(outcome.job, outcome.post!);
    commitOutcome(deps, before, outcome);
    deps.store.save();
  }
}

export async function runInbox(deps: InboxDeps, shouldStop: () => boolean = () => false): Promise<void> {
  let ack: string | undefined;
  while (!shouldStop()) {
    try {
      const due = nextProgressIn(deps.store.data, (deps.now ?? Date.now)());
      const delivery = await deps.orca.checkInbox(ack, Math.min(60_000, Math.max(1_000, due ?? 60_000)));
      ack = undefined;
      await startsSettled();
      await processBatch(deps, delivery.messages);
      if (delivery.messages.length && delivery.deliveryId) ack = delivery.deliveryId;
    } catch (err) {
      console.error("inbox error, retrying in 5s:", err);
      await sleep(5000);
    }
  }
}
