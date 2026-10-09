import { setTimeout as sleep } from "node:timers/promises";
import { applyInboxMessage, extractPrUrl, findJobByDispatch, markProcessed, parsePayload } from "./jobs.ts";
import type { InboxMessage } from "./jobs.ts";
import { startsSettled } from "./bot.ts";
import { readReport, toSlackMrkdwn } from "./report.ts";
import type { Poster } from "./bot.ts";
import type { Orca } from "./orca.ts";
import type { StoreHandle } from "./store.ts";

export type InboxDeps = {
  orca: Pick<Orca, "checkInbox" | "release" | "lookupPrUrl">;
  poster: Poster;
  store: StoreHandle;
};

async function prFallback(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done" || extractPrUrl(msg.body ?? "")) return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  if (!job?.worktreeId) return undefined;
  return deps.orca.lookupPrUrl(job.worktreeId, job.repo.owner, job.repo.name);
}

const MAX_REPORT = 3500;

async function renderedReport(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done") return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  const report = job && (await readReport(job.id));
  if (!report) return undefined;
  const text = toSlackMrkdwn(report.replace(/^\s*\**PR:?\**:?\s*\S+\s*$/gim, "").trim());
  return text.length > MAX_REPORT ? `${text.slice(0, MAX_REPORT)}…` : text;
}

/** Post first, then record the message as processed, so a crash re-posts at most once and never drops. */
export async function processBatch(deps: InboxDeps, messages: readonly InboxMessage[]): Promise<void> {
  for (const msg of messages) {
    const data = deps.store.data;
    if (data.processedMsgIds.includes(msg.id)) continue;
    const outcome = applyInboxMessage(data, msg, await prFallback(deps, msg), await renderedReport(deps, msg));
    if (outcome?.post) await deps.poster.postToThread(outcome.job, outcome.post);
    if (outcome) data.jobs[outcome.job.id] = outcome.job;
    markProcessed(data, msg.id);
    deps.store.save();
    if (outcome?.release) {
      await deps.orca.release(outcome.release).catch((err) => console.error(`worker-release ${outcome.release} failed:`, err));
    }
  }
}

export async function runInbox(deps: InboxDeps, shouldStop: () => boolean = () => false): Promise<void> {
  let ack: string | undefined;
  while (!shouldStop()) {
    try {
      const delivery = await deps.orca.checkInbox(ack);
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
