import { lastRun, sameRepo } from "./jobs.ts";
import type { Job, Mode } from "./jobs.ts";

export const MAX_ANTECEDENTS = 3;

/** What a new job learns about one earlier job in another thread. */
export type EarlierWork = { mode: Mode; outcome: string; prUrl?: string; summary?: string; permalink?: string };

function prOf(job: Job): { owner: string; name: string; number: number } | undefined {
  const run = lastRun(job);
  const url = run?.kind === "done" ? run.prUrl : undefined;
  const m = url && /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : undefined;
}

/**
 * Earlier jobs of other threads that worked on this target, newest first: the same repo and issue or PR number,
 * or an earlier job whose PR is this target. Issues and PRs share one number space per repo, so equal numbers are the same item.
 */
export function findAntecedents(jobs: Iterable<Job>, target: { owner: string; name: string; issue?: { number: number } }, threadJobId: string): Job[] {
  const n = target.issue?.number;
  if (n === undefined) return [];
  return [...jobs]
    .filter((job) => {
      if (job.id === threadJobId) return false;
      const pr = prOf(job);
      return (sameRepo(job, target) && job.issue?.number === n) || (pr !== undefined && sameRepo({ repo: pr }, target) && pr.number === n);
    })
    .sort((a, b) => Number(b.slack.threadTs) - Number(a.slack.threadTs))
    .slice(0, MAX_ANTECEDENTS);
}

export function outcomeLabel(job: Job): string {
  const state = lastRun(job) ?? job.state;
  switch (state.kind) {
    case "done":
      return state.outcome === "succeeded" ? "terminado" : "falló";
    case "cancelled":
      return "cancelado";
    case "failed":
      return "no arrancó";
    default:
      return "en curso";
  }
}

export function earlierWork(job: Job, permalink: string | undefined): EarlierWork {
  const run = lastRun(job);
  return {
    mode: job.mode,
    outcome: outcomeLabel(job),
    prUrl: run?.kind === "done" ? run.prUrl : undefined,
    summary: run?.kind === "done" ? run.summary : undefined,
    permalink,
  };
}

/** The thread post: one line per earlier job. */
export function antecedentsPost(earlier: readonly EarlierWork[]): string {
  return earlier.map((w) => `🔗 esto ya se trabajó en ${w.permalink ?? "otro hilo"} (${w.outcome}, ${w.prUrl ?? "sin PR"})`).join("\n");
}
