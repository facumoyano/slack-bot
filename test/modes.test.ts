import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMention } from "../src/bot.ts";
import type { Mention } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { planPath } from "../src/report.ts";
import { fakes } from "./fakes.ts";

const target = { owner: "acme", name: "api", source: "link" as const };

function mention(over: Partial<Mention> = {}): Mention {
  return { channel: "C1", threadTs: "100.1", ts: "100.1", user: "U1", text: "¿por qué el webhook responde 500?", target, ...over };
}

const done = (id: string, body: string): InboxMessage => ({ id, type: "worker_done", body, payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) });

test("!investiga starts a worker with the investigate spec and announces it with 🔎", async () => {
  const f = fakes();

  await handleMention(f.deps, mention({ command: "investiga" }));

  const job = f.store.data.jobs["C1:100.1"];
  assert.equal(job.mode, "investigate");
  assert.equal(job.state.kind, "working");
  assert.equal(f.posts[0], "🔎 investigo en acme/api…");
  assert.match(f.specs[0], /Investigation playbook/);
  assert.doesNotMatch(f.specs[0], /gh pr create/);
});

test("a plain mention after an investigation resumes the same session as a change run", async () => {
  const f = fakes();
  await handleMention(f.deps, mention({ command: "investiga" }));
  await processBatch(f.deps, [done("m1", "Encontré la causa.")]);

  await handleMention(f.deps, mention({ ts: "100.9", text: "ahora arreglalo" }));

  const job = f.store.data.jobs["C1:100.1"];
  assert.equal(job.mode, "change");
  assert.equal(job.request, "ahora arreglalo");
  assert.ok(f.calls.includes("terminal r1::/wt/api claude --dangerously-skip-permissions --resume sess-1"), "resumes the investigation's session");
  assert.equal(f.posts.at(-1), "🫡 sigo sobre el mismo worktree. Te aviso por acá.");
  const spec = f.specs.at(-1)!;
  assert.match(spec, /continuing your own previous work/);
  assert.match(spec, /This spec replaces your previous run's spec/);
  assert.match(spec, /gh pr create/);
  assert.doesNotMatch(spec, /Investigation playbook/);
});

test("the command on a follow-up picks that run's mode", async () => {
  const f = fakes();
  await handleMention(f.deps, mention({ text: "arreglá el login" }));
  await processBatch(f.deps, [done("m1", "Listo\nPR: https://github.com/acme/api/pull/1")]);

  await handleMention(f.deps, mention({ ts: "100.9", text: "¿se puede romper otra cosa?", command: "investiga" }));
  assert.equal(f.store.data.jobs["C1:100.1"].mode, "investigate");
  assert.equal(f.posts.at(-1), "🔎 investigo sobre el mismo worktree…");
  assert.match(f.specs.at(-1)!, /Investigation playbook/);

  await processBatch(f.deps, [{ ...done("m2", "No."), payload: JSON.stringify({ dispatchId: "d3", outcome: "succeeded" }) }]);
  await handleMention(f.deps, mention({ ts: "100.10", text: "sumá un test", command: "plan" }));
  assert.equal(f.store.data.jobs["C1:100.1"].mode, "plan");
  assert.match(f.specs.at(-1)!, /## Plan approval/);
});

test("!plan announces that it shows a plan before touching code", async () => {
  const f = fakes();

  await handleMention(f.deps, mention({ text: "arreglá el issue 1717", command: "plan" }));

  assert.equal(f.store.data.jobs["C1:100.1"].mode, "plan");
  assert.equal(f.posts[0], "📋 armo un plan en acme/api, te lo muestro antes de tocar código.");
  assert.match(f.specs[0], new RegExp(planPath("C1:100.1").replaceAll(".", "\\.")));
});
