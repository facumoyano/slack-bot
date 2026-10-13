import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClick } from "../src/blocks.ts";
import { handleClick, handleMention } from "../src/bot.ts";
import type { ClickInput, Mention } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import { THRESHOLDS, decideRoute, routeHint, routeState } from "../src/route.ts";
import type { Route, RouteAnswer, RouteState } from "../src/route.ts";
import { fakes, workingJob } from "./fakes.ts";

const target = { owner: "acme", name: "api", source: "link" as const };

function mention(over: Partial<Mention> = {}): Mention {
  return { channel: "C1", threadTs: "100.1", ts: "100.1", user: "U1", text: "¿qué dice el README?", target, context: "hilo previo", ...over };
}

function answer(choice: Route, confidence: number): RouteAnswer {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

/** Fakes whose Jev answers `reply` (or throws it) and records what it was asked. */
function routed(reply: RouteAnswer | Error) {
  const f = fakes();
  const asked: RouteState[] = [];
  f.deps.classify = async (state) => {
    asked.push(state);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { ...f, asked };
}

function buttonsOf(message: { blocks?: unknown[] }): any[] {
  return (message.blocks ?? []).flatMap((b: any) => (b.type === "actions" ? b.elements : []));
}

test("decideRoute acts on read-only routes at moderate confidence and needs high confidence for change, plan and none", () => {
  assert.deepEqual(decideRoute(answer("investigate", 0.55)), { kind: "route", route: "investigate" });
  assert.deepEqual(decideRoute(answer("question", 0.5)), { kind: "route", route: "question" });
  assert.deepEqual(decideRoute(answer("review", 0.45)), { kind: "ask" });
  assert.deepEqual(decideRoute(answer("change", 0.79)), { kind: "ask" });
  assert.deepEqual(decideRoute(answer("change", 0.8)), { kind: "route", route: "change" });
  assert.deepEqual(decideRoute(answer("plan", 0.7)), { kind: "ask" });
  assert.deepEqual(decideRoute(answer("none", 0.7)), { kind: "ask" });
  assert.ok(THRESHOLDS.change > THRESHOLDS.investigate);
});

test("Jev sees the mention, the thread's job, the links and a short slice of the thread as named fields", () => {
  const job = { ...workingJob(), state: { kind: "done" as const, outcome: "succeeded" as const, summary: "", prUrl: "https://github.com/acme/api/pull/9" } };
  const state = routeState({ text: "mirá https://github.com/acme/api/pull/12", context: "x".repeat(5000) }, job);
  assert.deepEqual({ ...state, thread_context: state.thread_context?.length }, {
    mention: "mirá https://github.com/acme/api/pull/12",
    thread_job: { mode: "change", state: "done", pr: "https://github.com/acme/api/pull/9" },
    mention_has_pr_link: true,
    mention_has_issue_link: false,
    thread_context: 1500,
  });
  assert.deepEqual(routeState({ text: "https://github.com/acme/api/issues/3" }, undefined), {
    mention: "https://github.com/acme/api/issues/3",
    thread_job: null,
    mention_has_pr_link: false,
    mention_has_issue_link: true,
    thread_context: null,
  });
});

test("a command skips Jev", async () => {
  const f = routed(answer("none", 1));

  await handleMention(f.deps, mention({ command: "investiga", text: "¿por qué falla?" }));

  assert.equal(f.asked.length, 0);
  assert.equal(f.store.data.jobs["C1:100.1"].mode, "investigate");
});

test("a confident question goes the !pregunta way: an answer, no worker, no job, and the hint", async () => {
  const f = routed(answer("question", 0.97));

  await handleMention(f.deps, mention());

  assert.equal(f.asked[0].mention, "¿qué dice el README?");
  assert.ok(f.calls.includes("ask /repos/api ¿qué dice el README?"));
  assert.ok(!f.calls.some((c) => c.startsWith("start")));
  assert.equal(Object.keys(f.store.data.jobs).length, 0);
  assert.match(f.posts.at(-1)!, /Se valida en \*src\/webhook\.ts:12\*\.\n_\(lo tomé como pregunta rápida; si no era eso, usá `!investiga`, `!revisa`, `!plan` o pedí el cambio explícito\)_$/);
});

for (const [route, confidence, first] of [
  ["investigate", 0.6, "🔎 investigo en acme/api…"],
  ["review", 0.6, "🔍 reviso acme/api#7…"],
  ["plan", 0.9, "📋 armo un plan en acme/api, te lo muestro antes de tocar código."],
  ["change", 0.95, "🫡 tomo el pedido en acme/api. Te aviso por acá."],
] as const) {
  test(`a ${route} route at ${confidence} starts that mode and says how it understood the mention`, async () => {
    const f = routed(answer(route, confidence));
    const own = route === "review" ? { ...target, issue: { number: 7, url: "https://github.com/acme/api/pull/7" } } : target;

    await handleMention(f.deps, mention({ text: "algo", target: own }));

    const job = f.store.data.jobs["C1:100.1"];
    assert.equal(job.mode, route);
    assert.equal(job.request, "algo");
    assert.equal(f.posts[0], `${first}\n_${routeHint(route)}_`);
    assert.match(f.posts[0], new RegExp(`lo tomé como`));
  });
}

test("a confident none only reacts 👍: no post, no worker", async () => {
  const f = routed(answer("none", 0.95));

  await handleMention(f.deps, mention({ text: "ok gracias" }));

  assert.deepEqual(f.reactions, ["100.1:thumbsup"]);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.calls, []);
});

for (const [why, reply] of [
  ["a change below its threshold", answer("change", 0.7)],
  ["a read-only route below its threshold", answer("investigate", 0.3)],
  ["an unsure none", answer("none", 0.6)],
  ["a TypeSafe error or timeout", new Error("The operation was aborted due to timeout")],
] as const) {
  test(`${why} does not guess: it asks with one button per route and starts nothing`, async () => {
    const f = routed(reply);

    await handleMention(f.deps, mention({ text: "fijate esto" }));

    assert.deepEqual(f.calls, []);
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0], "¿Qué querés que haga?");
    assert.deepEqual(buttonsOf(f.messages[0]).map((b) => b.text.text), ["Cambio de código", "Pregunta rápida", "Investigar", "Revisar PR", "Plan"]);
    assert.equal(Object.keys(f.store.data.jobs).length, 0);
  });
}

async function askedRoute() {
  const f = routed(answer("change", 0.4));
  await handleMention(f.deps, mention({ text: "fijate por qué falla el login", user: "U1" }));
  const posted = f.messages[0];
  const buttons = buttonsOf(posted);
  const clickOn = (label: string, user = "U2"): ClickInput => {
    const b = buttons.find((x) => x.text.text === label);
    return { click: parseClick(b.action_id, b.value)!, user, channel: "C1", threadTs: "100.1", messageTs: posted.ts };
  };
  return { f, posted, clickOn };
}

test("clicking Investigar runs investigate with the original mention, for its requester, and retires the buttons", async () => {
  const { f, posted, clickOn } = await askedRoute();

  await handleClick(f.deps, clickOn("Investigar"));

  const job = f.store.data.jobs["C1:100.1"];
  assert.equal(job.mode, "investigate");
  assert.equal(job.request, "fijate por qué falla el login");
  assert.equal(job.slack.requester, "U1");
  assert.match(f.specs[0], /Investigation playbook/);
  assert.equal(f.updates[0].ts, posted.ts);
  assert.equal(f.updates[0].text, "¿Qué querés que haga?\n✅ <@U2> eligió: Investigar");
  assert.equal(buttonsOf(f.updates[0]).length, 0);
  assert.equal(f.posts.at(-1), "🔎 investigo en acme/api…", "a picked route needs no hint");
  assert.equal(f.asked.length, 1, "the click does not ask Jev again");
});

test("clicking Pregunta rápida answers without a worker", async () => {
  const { f, clickOn } = await askedRoute();

  await handleClick(f.deps, clickOn("Pregunta rápida"));

  assert.deepEqual(f.calls, ["repo-path r1", "ask /repos/api fijate por qué falla el login"]);
});

test("a route button works once: a second or racing click is stale and starts nothing more", async () => {
  const { f, clickOn } = await askedRoute();

  await Promise.all([handleClick(f.deps, clickOn("Investigar")), handleClick(f.deps, clickOn("Plan"))]);
  await handleClick(f.deps, clickOn("Cambio de código"));

  assert.equal(f.calls.filter((c) => c.startsWith("start")).length, 1);
  assert.equal(f.ephemerals.length, 2);
  assert.ok(f.ephemerals.every((e) => /ya no es válido/.test(e)));
});

test("a route button from someone not allowed changes nothing", async () => {
  const { f, clickOn } = await askedRoute();

  await handleClick(f.deps, clickOn("Investigar", "U9"));

  assert.deepEqual(f.calls, []);
  assert.match(f.ephemerals[0], /no tengo permiso/);
  assert.ok(f.store.data.pendingRoutes["C1:100.1"], "the question is still open");
});

test("a newer ask in the thread retires the older buttons", async () => {
  const f = routed(answer("change", 0.4));
  await handleMention(f.deps, mention({ text: "uno" }));
  await handleMention(f.deps, mention({ ts: "100.5", text: "dos" }));

  assert.equal(f.updates[0].ts, f.messages[0].ts);
  assert.equal(f.store.data.pendingRoutes["C1:100.1"].ts, f.messages[1].ts);
  assert.equal(f.store.data.pendingRoutes["C1:100.1"].mention.text, "dos");
});

test("a plain follow-up is routed too: Jev sees the thread's job and the follow-up runs in the mode it picked", async () => {
  const f = routed(answer("investigate", 0.9));
  f.store.data.jobs["C1:100.1"] = workingJob();
  await processBatch(f.deps, [{ id: "m1", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) }]);

  await handleMention(f.deps, mention({ ts: "100.9", text: "¿por qué rompió los tests?" }));

  assert.deepEqual(f.asked[0].thread_job, { mode: "change", state: "done", pr: "https://github.com/acme/api/pull/1" });
  assert.equal(f.store.data.jobs["C1:100.1"].mode, "investigate");
  assert.equal(f.posts.at(-1), `🔎 investigo en la misma sesión…\n_${routeHint("investigate")}_`);
});

test("without a TypeSafe key a plain mention is a change, as before", async () => {
  const f = fakes();

  await handleMention(f.deps, mention({ text: "arreglá el login" }));

  assert.equal(f.store.data.jobs["C1:100.1"].mode, "change");
  assert.equal(f.posts[0], "🫡 tomo el pedido en acme/api. Te aviso por acá.");
});

test("a route click is only one of the five routes on a valid thread id", () => {
  assert.deepEqual(parseClick("alfred_route_review", "C1:100.1"), { kind: "route", jobId: "C1:100.1", route: "review" });
  assert.equal(parseClick("alfred_route_none", "C1:100.1"), undefined);
  assert.equal(parseClick("alfred_route_change", "not a thread"), undefined);
});
