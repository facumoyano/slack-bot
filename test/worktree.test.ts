import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMention } from "../src/bot.ts";
import { transition } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { OrcaError, worktreeSelector } from "../src/orca.ts";
import { fakes, workingJob } from "./fakes.ts";

const OLD_REPO = "8b34a43c-old";
const PATH = "/home/facu/orca/workspaces/fyso-backend/fyso-backend-issue-1752-02024869";

test("a job's worktree is addressed by its path, whatever repo id it was stored with", () => {
  assert.equal(worktreeSelector(`${OLD_REPO}::${PATH}`), `path:${PATH}`);
});

/** Orca after the repo was removed and re-added: the old repo id matches nothing. */
function orcaWithNewRepoId() {
  const reject = (selector: string) => {
    if (selector.startsWith("id:")) throw new OrcaError("selector_not_found", `no worktree ${selector}`);
  };
  return fakes({
    async createTerminal(o) {
      reject(o.worktree);
      return "term-1";
    },
    async startWorkerInTerminal(o) {
      reject(o.worktree);
      return { taskId: "t3", dispatchId: "d3" };
    },
    async startInWorktree(o) {
      reject(o.worktree);
      return { taskId: "t2", dispatchId: "d2" };
    },
  });
}

function oldDoneJob(sessionId?: string): Job {
  const started = { ...workingJob(), repo: { owner: "acme", name: "api", orcaRepoId: OLD_REPO }, worktreeId: `${OLD_REPO}::${PATH}` };
  return transition(started, { kind: "worker_done", outcome: "succeeded", summary: "Hecho.", prUrl: "https://github.com/acme/api/pull/1", sessionId })!;
}

const followUp = { channel: "C1", threadTs: "100.1", ts: "100.9", user: "U1", text: "agregá un test" };

test("an old job whose stored repo id no longer exists still resumes its session in the same worktree", async () => {
  const f = orcaWithNewRepoId();
  f.store.data.jobs["C1:100.1"] = oldDoneJob("sess-1");

  await handleMention(f.deps, followUp);

  const job = f.store.data.jobs["C1:100.1"];
  assert.equal(job.state.kind, "working");
  assert.equal(job.dispatchId, "d3", "the resumed session took the task");
  assert.equal(job.worktreeId, `${OLD_REPO}::${PATH}`);
  assert.ok(!f.posts.some((p) => p.startsWith("⚠️ no pude retomar")), "no fallback to a fresh worker");
});

test("an old job without a session still gets its fresh follow-up in the same worktree", async () => {
  const f = orcaWithNewRepoId();
  f.store.data.jobs["C1:100.1"] = oldDoneJob();

  await handleMention(f.deps, followUp);

  assert.equal(f.store.data.jobs["C1:100.1"].dispatchId, "d2");
  assert.ok(!f.posts.some((p) => p.startsWith("❌")));
});
