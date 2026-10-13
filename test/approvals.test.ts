import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bolt from "@slack/bolt";
import { APPROVAL_TTL_MS } from "../src/approvals.ts";
import { parseClick } from "../src/blocks.ts";
import { expireApprovals, handleClick, handleMention, handleThreadReply } from "../src/bot.ts";
import type { ClickInput, Mention } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { registerMentions } from "../src/slack.ts";
import { openStore } from "../src/store.ts";
import { fakes, workingJob } from "./fakes.ts";

const target = { owner: "acme", name: "api", issue: { number: 5, url: "https://github.com/acme/api/issues/5" }, source: "link" as const };

function mention(over: Partial<Mention> = {}): Mention {
  return { channel: "C1", threadTs: "1.1", ts: "1.1", user: "T1", text: "arreglá el login", target, ...over };
}

function buttonsOf(message: { blocks?: unknown[] }): any[] {
  return (message.blocks ?? []).flatMap((b: any) => (b.type === "actions" ? b.elements : []));
}

/** A click on the button labelled `label` of an owner's DM card. */
function cardClick(f: ReturnType<typeof fakes>, label: "Aprobar" | "Rechazar", user = "U1", card = f.dms[0]): ClickInput {
  const button = buttonsOf(card).find((b) => b.text.text === label);
  return { click: parseClick(button.action_id, button.value)!, user, channel: card.channel, threadTs: card.ts, messageTs: card.ts };
}

const done = (id: string, dispatchId = "d1"): InboxMessage => ({
  id,
  type: "worker_done",
  body: "Listo\nPR: https://github.com/acme/api/pull/1",
  payload: JSON.stringify({ dispatchId, outcome: "succeeded" }),
});

test("a teammate's mention starts nothing: the request is stored, the mention gets 👀, every owner gets a card", async () => {
  const f = fakes();

  await handleMention(f.deps, mention({ files: [{ id: "F1", name: "captura.png" }] }));

  assert.deepEqual(f.calls, [], "no worker, no ask");
  assert.deepEqual(f.posts, [], "nothing in the thread");
  assert.deepEqual(f.reactions, ["1.1:eyes"]);
  assert.equal(f.store.data.jobs["C1:1.1"], undefined);
  const approval = f.store.data.approvals["C1:1.1"];
  assert.deepEqual([approval.state.kind, approval.mention.user, approval.mention.text, approval.work, approval.target], ["pending", "T1", "arreglá el login", "change", "acme/api#5"]);
  assert.deepEqual(f.dms.map((d) => d.user), ["U1", "U2"]);
  const card = f.dms[0];
  assert.match(card.text, /<@T1> me pidió algo en <#C1> \(<https:\/\/slack\.test\/C1\/1\.1\|ver mensaje>\)/);
  assert.match(card.text, /^> arreglá el login$/m);
  assert.match(card.text, /\*Repo:\* acme\/api#5/);
  assert.match(card.text, /\*Qué haría:\* cambio de código con PR$/m);
  assert.match(card.text, /\*Archivos:\* 1 \(captura\.png\)/);
  assert.deepEqual(buttonsOf(card).map((b) => [b.text.text, b.style]), [["Aprobar", "primary"], ["Rechazar", "danger"]]);
  assert.deepEqual(approval.cards, [{ channel: "D-U1", ts: "700.1" }, { channel: "D-U2", ts: "700.2" }]);
});

test("the card names what would run: !pregunta, a Jev-routed investigation, !revisa, !nuevo", async () => {
  const cases: [Partial<Mention>, RegExp][] = [
    [{ command: "pregunta", text: "¿dónde se valida el token?" }, /pregunta rápida leyendo el repo, sin worker/],
    [{ text: "¿por qué falla el webhook?" }, /investigación con reporte, sin PR/],
    [{ command: "revisa", text: "https://github.com/acme/api/pull/7", target: { owner: "acme", name: "api", issue: { number: 7, url: "https://github.com/acme/api/pull/7" }, source: "link" } }, /revisión de PR, sin tocarlo/],
    [{ command: "nuevo", ts: "1.5" }, /cambio de código con PR, en un hilo nuevo del canal/],
  ];
  for (const [over, expected] of cases) {
    const f = fakes();
    f.deps.classify = async () => ({ choice: "investigate", confidence: 0.9, probabilities: {} });
    await handleMention(f.deps, mention(over));
    assert.deepEqual(f.calls, [], String(expected));
    assert.deepEqual(f.posts, [], "no top-level post for !nuevo before approval either");
    assert.match(f.dms[0].text, expected);
  }
});

test("a teammate's mention that lacks a repo is told so directly, without bothering the owner", async () => {
  const f = fakes();
  await handleMention(f.deps, mention({ target: undefined }));
  assert.deepEqual(f.dms, []);
  assert.match(f.posts[0], /^<@T1> no encontré qué repo o issue tocar/);
});

test("Aprobar runs exactly what an owner's mention runs, for the teammate; the cards say who approved", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());

  await handleClick(f.deps, cardClick(f, "Aprobar"));

  const owner = fakes();
  await handleMention(owner.deps, mention({ user: "U1" }));
  assert.deepEqual(f.calls, owner.calls);
  assert.deepEqual(f.specs, owner.specs.map((spec) => spec.replaceAll(owner.deps.filesRoot, f.deps.filesRoot).replace("by user U1", "by user T1")));
  assert.deepEqual(f.posts, owner.posts.map((p) => p.replaceAll("<@U1>", "<@T1>")));
  const job = f.store.data.jobs["C1:1.1"];
  assert.deepEqual([job.slack.requester, job.state.kind], ["T1", "working"]);
  assert.equal(f.store.data.approvals["C1:1.1"].state.kind, "approved");
  assert.deepEqual(
    f.updates.map((u) => [u.ts, u.text.split("\n").at(-1), buttonsOf(u).length]),
    [
      ["700.1", "*✅ aprobado* por <@U1>", 0],
      ["700.2", "*✅ aprobado* por <@U1>", 0],
    ],
  );
});

test("a second click, by the same or the other owner, is told it is decided and runs nothing again", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());
  await Promise.all([handleClick(f.deps, cardClick(f, "Aprobar")), handleClick(f.deps, cardClick(f, "Rechazar", "U2", f.dms[1]))]);
  await handleClick(f.deps, cardClick(f, "Aprobar"));

  assert.deepEqual(f.calls, ["start api-issue-5-11"]);
  assert.deepEqual(f.ephemerals, ["U2: Ese pedido ya está decidido.", "U1: Ese pedido ya está decidido."]);
});

test("a card click by anyone but an owner changes nothing", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());

  await handleClick(f.deps, cardClick(f, "Aprobar", "T1"));
  await handleClick(f.deps, cardClick(f, "Aprobar", "U9"));

  assert.deepEqual(f.calls, []);
  assert.equal(f.store.data.approvals["C1:1.1"].state.kind, "pending");
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.ephemerals, ["T1: Perdón <@T1>, este botón no es para vos.", "U9: Perdón <@U9>, este botón no es para vos."]);
});

test("Rechazar posts the fixed message in the thread and starts no worker", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());

  await handleClick(f.deps, cardClick(f, "Rechazar", "U2", f.dms[1]));

  assert.deepEqual(f.calls, []);
  assert.equal(f.store.data.jobs["C1:1.1"], undefined);
  assert.deepEqual(f.posts, ["🙅 <@T1>, por ahora no puedo tomar este pedido."]);
  assert.deepEqual(f.updates.map((u) => u.text.split("\n").at(-1)), ["*🚫 rechazado* por <@U2>", "*🚫 rechazado* por <@U2>"]);
});

test("a request expires after 24 h, once, and its buttons then say so", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());

  f.clock.now += APPROVAL_TTL_MS - 1;
  await expireApprovals(f.deps);
  assert.equal(f.store.data.approvals["C1:1.1"].state.kind, "pending");

  f.clock.now += 1;
  await expireApprovals(f.deps);
  await expireApprovals(f.deps);
  await handleClick(f.deps, cardClick(f, "Aprobar"));

  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.posts, ["⌛ <@T1>, no pude tomar este pedido; si sigue haciendo falta, volvé a mencionarme."]);
  assert.deepEqual(f.updates.map((u) => u.text.split("\n").at(-1)), ["*⌛ venció*", "*⌛ venció*"]);
  assert.deepEqual(f.ephemerals, ["U1: Ese pedido ya venció."]);
});

test("a click that lands after 24 h but before the sweep expires the request instead of running it", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());
  f.clock.now += APPROVAL_TTL_MS;

  await handleClick(f.deps, cardClick(f, "Aprobar"));

  assert.deepEqual(f.calls, []);
  assert.equal(f.store.data.approvals["C1:1.1"].state.kind, "expired");
});

test("a pending request survives a restart and its Aprobar still runs it", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "slack-bot-state-")), "state.json");
  const f = fakes();
  f.deps.store = openStore(path);
  await handleMention(f.deps, mention());

  f.deps.store = openStore(path);
  await handleClick(f.deps, cardClick(f, "Aprobar"));

  assert.deepEqual(f.calls, ["start api-issue-5-11"]);
  assert.equal(openStore(path).data.jobs["C1:1.1"].slack.requester, "T1");
});

test("a teammate picking the route of their own unclear mention asks for approval; another teammate's pick is refused", async () => {
  const f = fakes();
  f.deps.classify = async () => ({ choice: "change", confidence: 0.4, probabilities: {} });
  await handleMention(f.deps, mention({ text: "fijate el login" }));
  const ask = f.messages[0];
  const investigate = buttonsOf(ask).find((b) => b.text.text === "Investigar");
  const pick = (user: string): ClickInput => ({ click: parseClick(investigate.action_id, investigate.value)!, user, channel: "C1", threadTs: "1.1", messageTs: ask.ts });

  await handleClick(f.deps, pick("T2"));
  await handleClick(f.deps, pick("T1"));

  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.ephemerals, ["T2: Perdón <@T2>, este botón no es para vos."]);
  assert.equal(f.store.data.approvals["C1:1.1"].work, "investigate");
  await handleClick(f.deps, cardClick(f, "Aprobar"));
  assert.deepEqual(f.calls, ["start api-issue-5-11"]);
  assert.equal(f.store.data.jobs["C1:1.1"].mode, "investigate");
});

/** A job of T1's, approved and working, with a pending question from its worker. */
async function teammateJobAsking() {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = { ...workingJob(), slack: { channel: "C1", threadTs: "100.1", requester: "T1" } };
  await processBatch(f.deps, [{ id: "q1", type: "question", body: "¿Qué saludo?", payload: JSON.stringify({ dispatchId: "d1", question: "¿Qué saludo?", options: ["Hola", "Buenas"] }) }]);
  return f;
}

test("inside their approved job a teammate answers and guides the worker; another teammate is ignored", async () => {
  const f = await teammateJobAsking();
  const question = f.messages.at(-1)!;
  assert.match(question.text, /^<@T1> pregunta/);
  const option = (i: number, user: string): ClickInput => ({ click: parseClick(buttonsOf(question)[i].action_id, buttonsOf(question)[i].value)!, user, channel: "C1", threadTs: "100.1", messageTs: question.ts });

  await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.2", user: "T2", text: "decí chau" });
  await handleClick(f.deps, option(1, "T2"));
  assert.deepEqual(f.calls, []);
  await handleClick(f.deps, option(0, "T1"));
  await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.3", user: "T1", text: "y agregá un test" });
  await handleMention(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.4", user: "T1", text: "ojo con el README" });

  assert.deepEqual(f.calls, ["reply q1 Hola", "send d1 y agregá un test", "send d1 ojo con el README"]);
  assert.deepEqual(f.dms, [], "guidance in their own job needs no approval");
});

test("a teammate stops their own job; another teammate cannot", async () => {
  const f = await teammateJobAsking();
  const stop = (user: string): Mention => ({ channel: "C1", threadTs: "100.1", ts: "100.5", user, text: "", command: "parar" });

  await handleMention(f.deps, stop("T2"));
  assert.deepEqual(f.calls, []);
  assert.equal(f.posts.at(-1), "<@T2> no puedo parar este trabajo desde tu pedido.");

  await handleMention(f.deps, stop("T1"));
  assert.deepEqual(f.calls, ["stop d1"]);
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "cancelled");
});

test("a teammate may see the channel's repo but not set or clear it", async () => {
  const f = fakes();
  f.store.data.channels.C1 = { owner: "acme", name: "api" };
  const repo = (text: string): Mention => ({ channel: "C1", threadTs: "1.1", ts: "1.1", user: "T1", text, command: "repo" });

  await handleMention(f.deps, repo("fyso-backend"));
  await handleMention(f.deps, repo("acme/web"));
  await handleMention(f.deps, repo("borrar"));
  await handleMention(f.deps, repo(""));

  assert.deepEqual(f.store.data.channels.C1, { owner: "acme", name: "api" });
  assert.equal(f.posts[1], "No puedo cambiar el repo de este canal desde tu pedido.");
  assert.equal(f.posts[2], "No puedo cambiar el repo de este canal desde tu pedido.");
  assert.match(f.posts[3], /^📌 repo de este canal: acme\/api/);
});

test("a teammate's follow-up on their finished job needs a new approval, then resumes it for them", async () => {
  const f = fakes();
  await handleMention(f.deps, mention());
  await handleClick(f.deps, cardClick(f, "Aprobar"));
  await processBatch(f.deps, [done("w1")]);
  assert.equal(f.store.data.jobs["C1:1.1"].state.kind, "done");

  await handleMention(f.deps, mention({ ts: "1.9", text: "ahora agregá un test" }));

  assert.deepEqual(f.calls, ["start api-issue-5-11", "release d1"], "nothing resumed yet");
  const card = f.dms.at(-1)!;
  assert.match(card.text, /\*Qué haría:\* cambio de código con PR \(sigue la tarea de ese hilo\)/);
  await handleClick(f.deps, cardClick(f, "Aprobar", "U1", card));
  assert.deepEqual(f.calls.slice(2), ["terminal path:/wt/api claude --dangerously-skip-permissions --resume sess-1", "wait term-1", "resume term-1"]);
  assert.equal(f.store.data.jobs["C1:1.1"].slack.requester, "T1");
});

test("an owner's mention needs no approval", async () => {
  const f = fakes();
  await handleMention(f.deps, mention({ user: "U2" }));
  assert.deepEqual(f.calls, ["start api-issue-5-11"]);
  assert.deepEqual(f.dms, []);
});

test("nothing a teammate can see mentions an owner or an approval", async () => {
  const seen: string[] = [];
  const collect = (f: ReturnType<typeof fakes>) => seen.push(...f.posts, ...f.reactions, ...f.ephemerals.filter((e) => e.startsWith("T")));
  for (const decision of ["Aprobar", "Rechazar", "expire"] as const) {
    const f = fakes();
    await handleMention(f.deps, mention());
    if (decision === "expire") {
      f.clock.now += APPROVAL_TTL_MS;
      await expireApprovals(f.deps);
    } else await handleClick(f.deps, cardClick(f, decision));
    await handleClick(f.deps, cardClick(f, "Aprobar", "T1"));
    await handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.3", user: "T1", text: "acme/web", command: "repo" });
    collect(f);
  }
  const f = await teammateJobAsking();
  await handleMention(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.5", user: "T2", text: "", command: "parar" });
  await processBatch(f.deps, [done("w2")]);
  collect(f);

  assert.ok(seen.length > 8);
  for (const text of seen) {
    assert.doesNotMatch(text, /<@U1>|<@U2>|aprob|aprueb/i, text);
  }
});

function offlineApp() {
  return new bolt.App({ token: "xoxb-fake", appToken: "xapp-fake", socketMode: true, botId: "B1", botUserId: "UBOT", tokenVerificationEnabled: false, logLevel: bolt.LogLevel.ERROR });
}

function mentionEvent(event: Record<string, unknown>) {
  return {
    type: "event_callback",
    team_id: "TEAM",
    api_app_id: "A1",
    event_id: `Ev${Math.random()}`,
    event_time: 1,
    event: { type: "app_mention", channel: "C1", user: "U9", text: "<@UBOT> arreglá acme/api#5", ts: "1.1", event_ts: "1.1", ...event },
  };
}

async function until(done: () => boolean): Promise<void> {
  for (const end = Date.now() + 2000; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
}

test("from Slack: an unknown user gets today's refusal, another bot is ignored", async () => {
  const f = fakes();
  f.deps.botUserId = "UBOT";
  const app = offlineApp();
  registerMentions(app, f.deps, async () => []);
  const dispatch = (body: unknown) => app.processEvent({ body, ack: async () => {} } as Parameters<bolt.App["processEvent"]>[0]);

  await dispatch(mentionEvent({ user: "U8", bot_id: "B9" }));
  await dispatch(mentionEvent({}));
  await until(() => f.posts.length > 0);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(f.posts, ["Perdón <@U9>, no tengo permiso para trabajar para vos. Pedile al dueño del bot que agregue tu ID `U9` a ALLOWED_SLACK_USERS."]);
  assert.deepEqual([f.calls, f.dms, Object.keys(f.store.data.approvals)], [[], [], []]);
});
