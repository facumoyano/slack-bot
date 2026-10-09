import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseClick } from "../src/blocks.ts";
import { handleClick, handleMention, handleThreadReply } from "../src/bot.ts";
import type { Mention } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxMessage, Job } from "../src/jobs.ts";
import { planPath, reportPath } from "../src/report.ts";
import { fakes, workingJob } from "./fakes.ts";

const target = { owner: "acme", name: "api", source: "link" as const };

function mention(over: Partial<Mention> = {}): Mention {
  return { channel: "C1", threadTs: "100.1", ts: "100.1", user: "U1", text: "¿por qué el webhook responde 500?", target, ...over };
}

function buttonsOf(message: { blocks?: unknown[] }): any[] {
  return (message.blocks ?? []).flatMap((b: any) => (b.type === "actions" ? b.elements : []));
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

test("an investigation's worker_done without a PR posts 🔎 listo with the report, no ❌, no PR line, no Ver PR, even if the branch has a PR", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = { ...workingJob(), mode: "investigate" };

  await processBatch(f.deps, [done("m1", "Respondí la pregunta.")]);

  const post = f.messages[0];
  assert.equal(post.text, "🔎 <@U1> listo.\n\nRespondí la pregunta.");
  assert.equal(post.blocks, undefined, "no Ver PR button");
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "done");
  assert.ok(f.calls.includes("release d1"));
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
  assert.equal(f.posts.at(-1), "🫡 sigo en la misma sesión. Te aviso por acá.");
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
  assert.equal(f.posts.at(-1), "🔎 investigo en la misma sesión…");
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

const approval = (id: string): InboxMessage => ({
  id,
  type: "question",
  body: "¿Apruebo el plan?",
  payload: JSON.stringify({ dispatchId: "d1", question: "¿Apruebo el plan?", options: ["Aprobar", "Cambiar"] }),
});

/** A plan-mode job in its own thread, so its plan file under data/reports does not collide with other tests. */
async function planning(threadTs: string) {
  const f = fakes();
  const base = workingJob();
  const job: Job = { ...base, id: `CPLAN:${threadTs}`, slack: { ...base.slack, channel: "CPLAN", threadTs }, mode: "plan" };
  f.store.data.jobs[job.id] = job;
  const path = planPath(job.id);
  await mkdir(dirname(path), { recursive: true });
  const writePlan = (text: string) => writeFile(path, text);
  const cleanup = () => rm(path, { force: true });
  const ask = async (id: string) => {
    await processBatch(f.deps, [approval(id)]);
    const posted = f.messages.at(-1)!;
    const buttons = buttonsOf(posted);
    const click = (label: string, user = "U1") => {
      const b = buttons.find((e) => e.text.text === label);
      return handleClick(f.deps, { click: parseClick(b.action_id, b.value)!, user, channel: "CPLAN", threadTs, messageTs: posted.ts });
    };
    return { posted, buttons, click };
  };
  return { f, job, writePlan, cleanup, ask };
}

test("a plan question posts the plan rendered for Slack, then the question with Aprobar and Cambiar buttons", async (t) => {
  const p = await planning("300.1");
  t.after(p.cleanup);
  await p.writePlan("## Enfoque\n- Cambiar **src/webhook.ts**\n");

  const { buttons } = await p.ask("q1");

  assert.equal(p.f.messages.length, 2);
  assert.equal(p.f.messages[0].text, "📋 *Plan*\n\n*Enfoque*\n• Cambiar *src/webhook.ts*");
  assert.equal(buttonsOf(p.f.messages[0]).length, 0, "the plan itself has no buttons");
  assert.match(p.f.messages[1].text, /¿Apruebo el plan\?/);
  assert.deepEqual(buttons.map((b) => b.text.text), ["Aprobar", "Cambiar"]);
  assert.equal(p.f.store.data.jobs[p.job.id].state.kind, "awaiting_answer");
});

test("Cambiar asks for the change privately and leaves the question open; the typed reply is the answer", async (t) => {
  const p = await planning("300.2");
  t.after(p.cleanup);
  await p.writePlan("plan v1");
  const { click } = await p.ask("q1");

  await click("Cambiar");

  assert.deepEqual(p.f.calls, [], "no orca reply");
  assert.deepEqual(p.f.ephemerals, ["U1: Escribí en el hilo qué querés cambiar."]);
  assert.equal(p.f.store.data.jobs[p.job.id].state.kind, "awaiting_answer");
  assert.deepEqual(p.f.updates, [], "the buttons stay");

  await handleThreadReply(p.f.deps, { channel: "CPLAN", threadTs: "300.2", ts: "300.9", user: "U1", text: "que el saludo sea en inglés" });

  assert.deepEqual(p.f.calls, ["reply q1 que el saludo sea en inglés"]);
  assert.equal(p.f.store.data.jobs[p.job.id].state.kind, "working");
});

test("Aprobar answers Aprobar once, even clicked twice", async (t) => {
  const p = await planning("300.3");
  t.after(p.cleanup);
  await p.writePlan("plan v1");
  const { click } = await p.ask("q1");

  await Promise.all([click("Aprobar"), click("Aprobar")]);

  assert.deepEqual(p.f.calls, ["reply q1 Aprobar"]);
  assert.equal(p.f.store.data.jobs[p.job.id].state.kind, "working");
});

test("the plan is posted again only when the file changed since the last post", async (t) => {
  const p = await planning("300.4");
  t.after(p.cleanup);
  await p.writePlan("plan v1");
  await p.ask("q1");
  await handleThreadReply(p.f.deps, { channel: "CPLAN", threadTs: "300.4", ts: "300.5", user: "U1", text: "¿y los tests?" });

  await p.ask("q2");
  assert.equal(p.f.messages.filter((m) => m.text.startsWith("📋")).length, 1, "unchanged plan is not reposted");

  await handleThreadReply(p.f.deps, { channel: "CPLAN", threadTs: "300.4", ts: "300.6", user: "U1", text: "sumá tests" });
  await p.writePlan("plan v2 con tests");
  await p.ask("q3");
  const plans = p.f.messages.filter((m) => m.text.startsWith("📋"));
  assert.equal(plans.length, 2);
  assert.equal(plans[1].text, "📋 *Plan*\n\nplan v2 con tests");
  assert.match(p.f.messages.at(-1)!.text, /¿Apruebo el plan\?/, "the question with its buttons comes after the plan");
});

test("a change-mode question posts no plan, and Cambiar there is an ordinary answer", async (t) => {
  const p = await planning("300.5");
  t.after(p.cleanup);
  p.f.store.data.jobs[p.job.id] = { ...p.job, mode: "change" };
  await p.writePlan("not a plan run");

  const { click } = await p.ask("q1");
  await click("Cambiar");

  assert.equal(p.f.messages.length, 1);
  assert.deepEqual(p.f.calls, ["reply q1 Cambiar"]);
});

test("the report keeps labels that start with Pr while its PR line is dropped", async (t) => {
  const f = fakes();
  const base = workingJob();
  const job: Job = { ...base, id: "CREP:400.1", slack: { ...base.slack, channel: "CREP", threadTs: "400.1" }, mode: "investigate" };
  f.store.data.jobs[job.id] = job;
  const path = reportPath(job.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "**Pregunta**\n\n¿Qué hay?\n\n**Pruebas**\n\nNinguna.\n\n**PR:** https://github.com/acme/api/pull/7\nPR: https://github.com/acme/api/pull/7\n");
  t.after(() => rm(path, { force: true }));

  await processBatch(f.deps, [done("m1", "Listo.")]);

  assert.equal(f.posts[0], "🔎 <@U1> listo.\n\n*Pregunta*\n\n¿Qué hay?\n\n*Pruebas*\n\nNinguna.");
});
