import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, answeredMessage, doneMessage, parseClick, questionMessage, startMessage, textBlocks } from "../src/blocks.ts";

const jobId = "C1:100.1";

function actions(blocks: unknown[] | undefined): any[] {
  return (blocks ?? []).filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements);
}

test("a question with options gets one button per option whose click parses back to it", () => {
  const msg = questionMessage({ jobId, questionMsgId: "m1", requester: "U1", question: "¿Qué saludo?", options: ["Hola", "Buenas"] });

  assert.equal(msg.text, "<@U1> pregunta: ¿Qué saludo?\nOpciones: Hola / Buenas\n_Respondé en este hilo._");
  const buttons = actions(msg.blocks);
  assert.deepEqual(buttons.map((b) => [b.action_id, b.text.text]), [[`${ACTIONS.answer}_0`, "Hola"], [`${ACTIONS.answer}_1`, "Buenas"]]);
  assert.deepEqual(parseClick(buttons[1].action_id, buttons[1].value), { kind: "answer", jobId, questionMsgId: "m1", option: 1 });
});

test("no options or more than five stay a text list with no buttons", () => {
  assert.equal(questionMessage({ jobId, questionMsgId: "m1", requester: "U1", question: "¿?", options: [] }).blocks, undefined);
  const six = questionMessage({ jobId, questionMsgId: "m1", requester: "U1", question: "¿?", options: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(six.blocks, undefined);
  assert.match(six.text, /Opciones: a \/ b \/ c \/ d \/ e \/ f/);
});

test("an answered question has no buttons and says who answered what", () => {
  const msg = answeredMessage({ requester: "U1", question: "¿Qué saludo?", user: "U2", answer: "Hola" });
  assert.equal(msg.text, "<@U1> pregunta: ¿Qué saludo?\n✅ <@U2> respondió: Hola");
  assert.deepEqual(actions(msg.blocks), []);
});

test("the start message has a stop button, and a repo picker without the current repo when asked", () => {
  const current = { owner: "acme", name: "api" };
  const plain = startMessage({ jobId, text: "🫡 tomo", current });
  assert.equal(plain.text, "🫡 tomo");
  assert.deepEqual(actions(plain.blocks).map((e) => [e.type, e.action_id, e.value]), [["button", ACTIONS.stop, jobId]]);
  assert.deepEqual(parseClick(ACTIONS.stop, jobId), { kind: "stop", jobId });

  const picker = startMessage({ jobId, text: "🫡 tomo", current, repos: [current, { owner: "acme", name: "web" }] });
  const select = actions(picker.blocks).find((e) => e.type === "static_select");
  assert.equal(select.action_id, ACTIONS.repo);
  assert.deepEqual(select.options.map((o: any) => o.text.text), ["acme/web"]);
  assert.deepEqual(parseClick(ACTIONS.repo, select.options[0].value), { kind: "repo", jobId, repo: { owner: "acme", name: "web" } });
});

test("the final report links the PR with a URL button only when there is one", () => {
  const withPr = doneMessage("✅ listo", "https://github.com/acme/api/pull/3");
  assert.deepEqual(actions(withPr.blocks).map((e) => [e.action_id, e.url]), [[ACTIONS.pr, "https://github.com/acme/api/pull/3"]]);
  assert.deepEqual(doneMessage("❌ no"), { text: "❌ no" });
});

test("clicks that the builders could not have produced are rejected", () => {
  for (const [action, value] of [
    [ACTIONS.stop, "not a job"],
    [ACTIONS.stop, undefined],
    [ACTIONS.pr, "x"],
    [`${ACTIONS.answer}_0`, "{"],
    [`${ACTIONS.answer}_0`, JSON.stringify({ j: jobId, q: "m1", o: 1 })],
    [`${ACTIONS.answer}_7`, JSON.stringify({ j: jobId, q: "m1", o: 7 })],
    [`${ACTIONS.answer}_0`, JSON.stringify({ j: jobId, q: "", o: 0 })],
    [ACTIONS.repo, JSON.stringify({ j: jobId, r: "../etc" })],
    [ACTIONS.repo, JSON.stringify({ j: "x", r: "acme/web" })],
    ["other_action", jobId],
  ] as const) {
    assert.equal(parseClick(action, value), undefined, `${action} ${value}`);
  }
});

test("long text is split into sections under Slack's limit without losing a character", () => {
  const text = `${"a".repeat(2500)}\n${"b".repeat(2500)}\n${"c".repeat(7000)}`;
  const sections = textBlocks(text).map((b: any) => b.text.text as string);
  assert.deepEqual(sections.map((s) => s.length), [2500, 2500, 3000, 3000, 1000]);
  assert.equal(sections.join(""), text.replaceAll("\n", ""));
});
