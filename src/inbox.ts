import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { outboxDir, outboxFiles, retire } from "./files.ts";
import { applyInboxMessage, dueProgress, extractPrUrl, findJobByDispatch, markProcessed, nextProgressIn, parsePayload, transition } from "./jobs.ts";
import type { InboxMessage, InboxOutcome, Job } from "./jobs.ts";
import { expireApprovals, expireRelays, retireStart, startsSettled } from "./bot.ts";
import { readPlan, readRelay, readReport, slackPost, toSlackMrkdwn } from "./report.ts";
import type { Poster } from "./bot.ts";
import { worktreePath } from "./orca.ts";
import type { Orca } from "./orca.ts";
import type { StoreHandle } from "./store.ts";

export type InboxDeps = {
  orca: Pick<Orca, "checkInbox" | "release" | "lookupPrUrl" | "reply">;
  poster: Poster;
  store: StoreHandle;
  latestSession(worktreePath: string): Promise<string | undefined>;
  /** Where each job's `out/` folder lives. */
  filesRoot: string;
  now?(): number;
};

async function prFallback(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done" || extractPrUrl(msg.body ?? "")) return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  if (!job?.worktreeId) return undefined;
  return deps.orca.lookupPrUrl(job.worktreeId, job.repo.owner, job.repo.name);
}

function relayFile(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  return msg.type === "worker_done" && job?.state.kind === "relaying" ? readRelay(job.id) : Promise.resolve(undefined);
}

async function renderedReport(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "worker_done") return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  const report = job && (await readReport(job.id));
  if (!report) return undefined;
  return slackPost(report.replace(/^\s*\**PR\b:?\**:?\s*\S+\s*$/gim, "").trim());
}

async function renderedPlan(deps: InboxDeps, msg: InboxMessage): Promise<string | undefined> {
  if (msg.type !== "question") return undefined;
  const job = findJobByDispatch(deps.store.data, parsePayload(msg).dispatchId);
  if (job?.mode !== "plan") return undefined;
  const plan = await readPlan(job.id);
  return plan && toSlackMrkdwn(plan);
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

/** Uploads the worker's new outbox files; a failed one is said in the thread and retried with the next message. */
async function flushOutbox(deps: InboxDeps, job: Job): Promise<void> {
  const { ready, tooBig } = await outboxFiles(outboxDir(deps.filesRoot, job.id));
  for (const path of tooBig) {
    await deps.poster.postToThread(job, `⚠️ no subo ${basename(path)}: pesa más de 1 GB.`);
    await retire(path, "skipped");
  }
  for (const path of ready) {
    try {
      await deps.poster.uploadFile(job, path);
    } catch (err) {
      console.error(`uploading ${path} failed:`, err);
      await deps.poster.postToThread(job, `⚠️ no pude subir ${basename(path)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    await retire(path, "sent");
  }
}

/** Records the relay message's ts; a plain notice is done, and its owner gets the link to it. */
async function relayPosted(deps: InboxDeps, job: Job, ts: string, awaiting: string[]): Promise<Job> {
  const next = transition(job, { kind: "relay_posted", ts, at: (deps.now ?? Date.now)(), awaiting }) ?? job;
  if (awaiting.length || job.state.kind !== "relaying") return next;
  const { owner, link, dmThread } = job.state.relay;
  const posted = await deps.poster.permalink(job.slack.channel, ts).catch(() => link);
  await deps.poster.dm(owner, `✅ listo: ${posted}`, undefined, dmThread).catch((err) => console.error(`DM to ${owner} failed:`, err));
  return next;
}

/** Commits an outcome unless a mention changed the job (a cancel, a follow-up) while it was being posted. */
function commitOutcome(deps: InboxDeps, before: Job | undefined, outcome: InboxOutcome): boolean {
  if (deps.store.data.jobs[outcome.job.id] !== before) return false;
  deps.store.data.jobs[outcome.job.id] = outcome.job;
  return true;
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
      plan: await renderedPlan(deps, msg),
      relayFile: await relayFile(deps, msg),
    };
    const before = findJobByDispatch(data, parsePayload(msg).dispatchId);
    const outcome = applyInboxMessage(data, msg, extras, now());
    // Before the text, so a question carries its screenshot and the final report its evidence. A relay never uploads: the thread must not see it ran.
    if (outcome && before?.state.kind !== "relaying") await flushOutbox(deps, outcome.job);
    if (outcome?.lead) await deps.poster.postToThread(outcome.job, outcome.lead.text, outcome.lead.blocks);
    if (outcome?.post) {
      const ts = await deps.poster.postToThread(outcome.job, outcome.post, outcome.blocks);
      if (outcome.blocks && msg.type === "question") outcome.job = transition(outcome.job, { kind: "question_posted", msgId: msg.id, ts }) ?? outcome.job;
      if (outcome.relayPosted) outcome.job = await relayPosted(deps, outcome.job, ts, outcome.relayPosted.awaiting);
    }
    if (outcome?.dm) await deps.poster.dm(outcome.dm.user, outcome.dm.text, undefined, outcome.dm.threadTs).catch((err) => console.error(`DM to ${outcome.dm!.user} failed:`, err));
    if (outcome?.answer) await deps.orca.reply(outcome.answer.msgId, outcome.answer.text).catch((err) => console.error(`answering ${outcome.answer!.msgId} failed:`, err));
    const committed = outcome !== undefined && commitOutcome(deps, before, outcome);
    markProcessed(data, msg.id);
    deps.store.save();
    if (committed) await retireStart(deps, before, outcome.job);
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
      await expireApprovals(deps);
      await expireRelays(deps);
      if (delivery.messages.length && delivery.deliveryId) ack = delivery.deliveryId;
    } catch (err) {
      console.error("inbox error, retrying in 5s:", err);
      await sleep(5000);
    }
  }
}
