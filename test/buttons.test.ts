import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClick } from "../src/blocks.ts";
import { handleClick, handleMention, handleThreadReply } from "../src/bot.ts";
import type { ClickInput } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { fakes, workingJob } from "./fakes.ts";

const question: InboxMessage = {
  id: "m1",
  type: "question",
  body: "¿Qué saludo?",
  payload: JSON.stringify({ dispatchId: "d1", question: "¿Qué saludo?", options: ["Hola", "Buenas"] }),
};

async function asked() {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;
  await processBatch(f.deps, [question]);
  const posted = f.messages.at(-1)!;
  const buttons = (posted.blocks ?? []).flatMap((b: any) => (b.type === "actions" ? b.elements : []));
  const clickOn = (i: number, user = "U1"): ClickInput => ({
    click: parseClick(buttons[i].action_id, buttons[i].value)!,
    user,
    channel: "C1",
    threadTs: "100.1",
    messageTs: posted.ts,
  });
  return { f, job, posted, buttons, clickOn };
}

test("a question with options is posted with one button per option", async () => {
  const { posted, buttons } = await asked();
  assert.deepEqual(buttons.map((b: any) => b.text.text), ["Hola", "Buenas"]);
  assert.match(posted.text, /Opciones: Hola \/ Buenas/, "the text fallback still lists the options");
});

test("clicking an option answers once through orca reply and replaces the buttons with the answer", async () => {
  const { f, job, posted, clickOn } = await asked();

  await handleClick(f.deps, clickOn(1, "U2"));

  assert.deepEqual(f.calls, ["reply m1 Buenas"]);
  assert.equal(f.store.data.jobs[job.id].state.kind, "working");
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].ts, posted.ts);
  assert.match(f.updates[0].text, /✅ <@U2> respondió: Buenas$/);
  assert.equal(f.updates[0].blocks?.some((b) => b.type === "actions"), false);
  assert.deepEqual(f.ephemerals, []);
});

test("a second click, even one racing the first, sends no second reply and is told it is stale", async () => {
  const { f, clickOn } = await asked();

  await Promise.all([handleClick(f.deps, clickOn(0)), handleClick(f.deps, clickOn(1))]);
  await handleClick(f.deps, clickOn(0));

  assert.deepEqual(f.calls, ["reply m1 Hola"]);
  assert.equal(f.ephemerals.length, 2);
  assert.match(f.ephemerals[0], /^U1: Ese botón ya no es válido/);
});

test("a typed reply answers and retires the buttons, so a later click does nothing", async () => {
  const { f, posted, clickOn } = await asked();

  await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.5", user: "U1", text: "Qué tal" });
  await handleClick(f.deps, clickOn(0));

  assert.deepEqual(f.calls, ["reply m1 Qué tal"]);
  assert.deepEqual(f.updates.map((u) => [u.ts, u.text.split("\n").at(-1)]), [[posted.ts, "✅ <@U1> respondió: Qué tal"]]);
  assert.equal(f.ephemerals.length, 1);
});

test("a click from someone not allowlisted is refused privately and changes nothing", async () => {
  const { f, job, clickOn } = await asked();
  const before = f.store.data.jobs[job.id];

  await handleClick(f.deps, clickOn(0, "U9"));

  assert.deepEqual(f.calls, []);
  assert.equal(f.store.data.jobs[job.id], before);
  assert.deepEqual(f.updates, []);
  assert.match(f.ephemerals[0], /^U9: Perdón <@U9>, no tengo permiso/);
});

test("a click whose value names another thread than the message it sits in is stale", async () => {
  const { f, clickOn } = await asked();

  await handleClick(f.deps, { ...clickOn(0), threadTs: "555.5" });

  assert.deepEqual(f.calls, []);
  assert.equal(f.ephemerals.length, 1);
});

test("an older question's buttons cannot answer a newer question", async () => {
  const { f, clickOn } = await asked();
  const old = clickOn(0);
  await processBatch(f.deps, [{ ...question, id: "m2", payload: JSON.stringify({ dispatchId: "d1", question: "¿Y ahora?", options: ["Sí", "No"] }) }]);

  await handleClick(f.deps, old);

  assert.deepEqual(f.calls, []);
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "awaiting_answer");
});

const mention = { channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "arreglá el login" };

function startButtons(f: ReturnType<typeof fakes>) {
  const start = f.messages.find((m) => m.text.startsWith("🫡") || m.text.startsWith("🔁"))!;
  const elements = (start.blocks ?? []).flatMap((b: any) => (b.type === "actions" ? b.elements : []));
  return { start, elements };
}

test("the stop button does what !parar does and then disappears; a second click stops nothing", async () => {
  const f = fakes();
  await handleMention(f.deps, { ...mention, target: { owner: "acme", name: "api", source: "link" } });
  const { start, elements } = startButtons(f);
  assert.deepEqual(elements.map((e: any) => e.type), ["button"], "no repo picker for a repo the user named");
  const click: ClickInput = { click: parseClick(elements[0].action_id, elements[0].value)!, user: "U1", channel: "C1", threadTs: "1.1", messageTs: start.ts };

  await Promise.all([handleClick(f.deps, click), handleClick(f.deps, click)]);
  await handleClick(f.deps, click);

  assert.deepEqual(f.calls, ["start api-slack-11", "stop d1"]);
  assert.equal(f.store.data.jobs["C1:1.1"].state.kind, "cancelled");
  assert.match(f.posts.at(-1)!, /^⏹️ cancelado\. El trabajo queda en la rama `api-issue-5`/);
  assert.deepEqual(f.updates.map((u) => [u.ts, u.text, u.blocks?.some((b) => b.type === "actions")]), [[start.ts, start.text, false]]);
  assert.equal(f.ephemerals.length, 2);
});

test("a finished job's start message loses its stop button", async () => {
  const f = fakes();
  await handleMention(f.deps, { ...mention, target: { owner: "acme", name: "api", source: "link" } });
  const { start } = startButtons(f);

  await processBatch(f.deps, [
    { id: "w1", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) },
  ]);

  assert.deepEqual(f.updates.map((u) => u.ts), [start.ts]);
});
