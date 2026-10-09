import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMention, handleThreadReply } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import { newJob, transition } from "../src/jobs.ts";
import type { InboxMessage, Job } from "../src/jobs.ts";
import { fakes, workingJob } from "./fakes.ts";

const question: InboxMessage = {
  id: "m1",
  type: "question",
  subject: "Pregunta",
  body: "¿Qué saludo?",
  payload: JSON.stringify({ taskId: "t1", dispatchId: "d1", question: "¿Qué saludo?", options: ["Hola", "Buenas"] }),
};

test("a question moves the job to awaiting_answer and posts once, even when the batch replays", async () => {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;

  await processBatch(f.deps, [question]);
  await processBatch(f.deps, [question]);

  assert.deepEqual(f.store.data.jobs[job.id].state, { kind: "awaiting_answer", questionMsgId: "m1", question: "¿Qué saludo?" });
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0], /<@U1> pregunta: ¿Qué saludo\?/);
  assert.match(f.posts[0], /Hola \/ Buenas/);
});

test("a thread reply answers the pending question and the job resumes", async () => {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;
  await processBatch(f.deps, [question]);

  const handled = await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.5", text: "Hola mundo" });

  assert.equal(handled, true);
  assert.deepEqual(f.calls, ["reply m1 Hola mundo"]);
  assert.equal(f.store.data.jobs[job.id].state.kind, "working");
  assert.deepEqual(f.reactions, ["100.5:white_check_mark"]);
});

test("worker_done extracts the PR URL, reports it, and releases the worker", async () => {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;

  await processBatch(f.deps, [
    {
      id: "m2",
      type: "worker_done",
      subject: "done",
      body: "Arreglé el login.\nPR: https://github.com/acme/api/pull/12\n",
      payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }),
    },
  ]);

  assert.deepEqual(f.store.data.jobs[job.id].state, {
    kind: "done",
    outcome: "succeeded",
    summary: "Arreglé el login.",
    prUrl: "https://github.com/acme/api/pull/12",
  });
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0], /^✅/);
  assert.match(f.posts[0], /\*PR:\* https:\/\/github\.com\/acme\/api\/pull\/12/);
  assert.deepEqual(f.calls, ["release d1"]);
});

test("worker_done records the worktree's newest Claude session on the job", async () => {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;

  await processBatch(f.deps, [
    { id: "m5", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) },
  ]);

  assert.equal(f.store.data.jobs[job.id].sessionId, "sess-1");
});

test("worker_done without a PR line falls back to the branch lookup; failed outcome posts ❌", async () => {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;

  await processBatch(f.deps, [
    { id: "m3", type: "worker_done", body: "No pude pushear.", payload: JSON.stringify({ dispatchId: "d1", outcome: "failed" }) },
  ]);

  assert.match(f.posts[0], /^❌/);
  assert.match(f.posts[0], /pull\/99/);
  assert.deepEqual(f.calls, ["lookup", "release d1"]);
});

test("messages for unknown dispatches and heartbeats post nothing but are marked processed", async () => {
  const f = fakes();
  f.store.data.jobs[workingJob().id] = workingJob();

  await processBatch(f.deps, [
    { id: "h1", type: "heartbeat", payload: JSON.stringify({ dispatchId: "d1" }) },
    { ...question, id: "m9", payload: JSON.stringify({ dispatchId: "other" }) },
  ]);

  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.store.data.processedMsgIds, ["h1", "m9"]);
});

test("mention starts a worker; a mention after done resumes the worker's session on the same worktree", async () => {
  const f = fakes();
  const mention = {
    channel: "C1",
    threadTs: "100.1",
    ts: "100.1",
    user: "U1",
    text: "arreglalo",
    target: { owner: "acme", name: "api", issue: { number: 5, url: "https://github.com/acme/api/issues/5" }, source: "link" as const },
  };
  await handleMention(f.deps, mention);
  const id = "C1:100.1";
  assert.equal(f.store.data.jobs[id].state.kind, "working");
  assert.equal(f.store.data.jobs[id].dispatchId, "d1");
  assert.match(f.posts[0], /🫡 tomo el issue acme\/api#5/);

  await processBatch(f.deps, [
    { id: "m4", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) },
  ]);
  await handleMention(f.deps, { ...mention, ts: "100.9", text: "cambiá el título" });

  const job = f.store.data.jobs[id];
  assert.equal(job.state.kind, "working");
  assert.equal(job.dispatchId, "d3");
  assert.equal(job.request, "cambiá el título");
  assert.ok(f.calls.includes("resume term-1"), "resumes the session worker_done recorded");
});

test("mention with no target asks for the link and starts nothing", async () => {
  const f = fakes();
  await handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "arreglá esto" });
  assert.deepEqual(f.calls, []);
  assert.equal(Object.keys(f.store.data.jobs).length, 0);
  assert.match(f.posts[0], /Pasame el link del issue/);
});

function doneJob(sessionId?: string): Job {
  const done = transition(workingJob(), {
    kind: "worker_done",
    outcome: "failed",
    summary: "Memoricé la palabra.",
    prUrl: "https://github.com/acme/api/pull/1",
    sessionId,
  })!;
  return done;
}

const followUpMention = { channel: "C1", threadTs: "100.1", ts: "100.9", user: "U1", text: "¿cuál era la palabra?" };

test("a follow-up on a job with a session resumes that exact session with a resumed spec", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

  await handleMention(f.deps, followUpMention);

  const job = f.store.data.jobs["C1:100.1"];
  assert.deepEqual(f.calls, ["terminal r1::/wt/api claude --dangerously-skip-permissions --resume sess-1", "wait term-1", "resume term-1"]);
  assert.match(f.specs[0], /continuing your own previous work on this request, in this same Claude session/);
  assert.equal(job.state.kind, "working");
  assert.equal(job.dispatchId, "d3");
  assert.equal(job.request, "¿cuál era la palabra?");
});

test("when the resumed session cannot take the task, its terminal is closed and a fresh follow-up starts", async () => {
  const f = fakes({
    async startWorkerInTerminal() {
      throw new Error("terminal not ready");
    },
  });
  f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

  await handleMention(f.deps, followUpMention);

  assert.deepEqual(f.calls.slice(1), ["wait term-1", "close term-1", "followup r1::/wt/api"]);
  assert.match(f.specs[0], /BEGIN PREVIOUS SUMMARY[\s\S]*Memoricé la palabra/);
  assert.equal(f.store.data.jobs["C1:100.1"].dispatchId, "d2");
});

test("a resumed Claude that never goes idle gets one longer wait, then the fresh follow-up", async () => {
  const waits: number[] = [];
  const f = fakes({
    async waitTuiIdle(_h, ms) {
      waits.push(ms);
      return false;
    },
  });
  f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

  await handleMention(f.deps, followUpMention);

  assert.deepEqual(waits, [60_000, 120_000]);
  assert.deepEqual(f.calls.slice(1), ["close term-1", "followup r1::/wt/api"]);
});

test("a follow-up without a recorded session starts a fresh worker", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = doneJob();

  await handleMention(f.deps, followUpMention);

  assert.deepEqual(f.calls, ["followup r1::/wt/api"]);
});

const issue = (owner: string, name: string, n: number) => ({
  owner,
  name,
  issue: { number: n, url: `https://github.com/${owner}/${name}/issues/${n}` },
  source: "link" as const,
});

test("a mention naming the thread's own repo and issue is a normal follow-up", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

  await handleMention(f.deps, { ...followUpMention, ownTarget: issue("Acme", "API", 5) });

  assert.ok(f.calls.includes("resume term-1"));
});

test("a mention naming another issue or another repo is not mixed into the thread's task", async () => {
  for (const ownTarget of [issue("acme", "api", 6), issue("acme", "web", 5)]) {
    const f = fakes();
    f.deps.botUserId = "UBOT";
    f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

    await handleMention(f.deps, { ...followUpMention, ownTarget });

    assert.deepEqual(f.calls, []);
    assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "done");
    const other = `${ownTarget.owner}/${ownTarget.name}#${ownTarget.issue.number}`;
    assert.equal(f.posts.at(-1), `Este hilo es de acme/api#5. Si querés que tome ${other} como tarea aparte, escribí <@UBOT> \`!nuevo …\`.`);
  }
});

test("!nuevo inside a thread opens a new thread and keys the new job by its ts", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

  await handleMention(f.deps, {
    ...followUpMention,
    text: "sumá tests a acme/web",
    command: "nuevo",
    target: { owner: "acme", name: "web", source: "link" },
    context: "hilo original",
  });

  assert.match(f.posts[0], /^\[top\] 🆕 <@U1> pidió una tarea aparte desde otro hilo:\n> sumá tests a acme\/web/);
  const job = f.store.data.jobs["C1:200.1"];
  assert.equal(job.state.kind, "working");
  assert.deepEqual(job.repo, { owner: "acme", name: "web", orcaRepoId: "r1" });
  assert.equal(job.request, "sumá tests a acme/web");
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "done", "the original thread's job is untouched");
  assert.deepEqual(f.calls, ["start web-slack-2001"]);
});

test("a guessed repo is announced as a guess", async () => {
  const f = fakes();
  await handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "arreglá el login", target: { owner: "acme", name: "api", source: "inferred" } });

  assert.match(f.posts[0], /🫡 tomo el pedido en acme\/api \(lo deduje del hilo; si no es ese, mencioname con el repo correcto\)/);
  assert.equal(f.store.data.jobs["C1:1.1"].repoSource, "inferred");
});

test("correcting a guessed repo while working stops that worker and redoes the request on the named repo", async () => {
  const f = fakes();
  const guessed = { owner: "acme", name: "api", source: "inferred" as const };
  await handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "arreglá el login", target: guessed });

  await handleMention(f.deps, {
    channel: "C1",
    threadTs: "1.1",
    ts: "1.5",
    user: "U1",
    text: "no, es billing",
    target: guessed,
    ownTarget: { owner: "acme", name: "billing", source: "name" },
  });

  assert.deepEqual(f.calls, ["start api-slack-11", "stop d1", "start billing-slack-11"]);
  const job = f.store.data.jobs["C1:1.1"];
  assert.deepEqual(job.repo, { owner: "acme", name: "billing", orcaRepoId: "r1" });
  assert.equal(job.repoSource, "name");
  assert.equal(job.request, "arreglá el login");
  assert.equal(job.state.kind, "working");
  assert.equal(f.posts.at(-1), "🔁 cambio a acme/billing.");
});

test("if the guessed worker cannot be stopped, no second worker starts", async () => {
  const f = fakes({
    async stopWorker() {
      throw new Error("dispatch gone");
    },
  });
  const guessed = { owner: "acme", name: "api", source: "inferred" as const };
  await handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "arreglá el login", target: guessed });

  await handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.5", user: "U1", text: "es billing", ownTarget: { owner: "acme", name: "billing", source: "name" } });

  assert.deepEqual(f.calls, ["start api-slack-11"]);
  assert.equal(f.store.data.jobs["C1:1.1"].state.kind, "working");
  assert.match(f.posts.at(-1)!, /no pude frenar el worker de acme\/api \(dispatch gone\)/);
});

test("naming another repo in a thread whose repo came from a link is a conflict, not a correction", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await handleMention(f.deps, { ...followUpMention, ownTarget: { owner: "acme", name: "billing", source: "name" } });

  assert.deepEqual(f.calls, []);
  assert.match(f.posts.at(-1)!, /^Este hilo es de acme\/api#5\. .*mencioname con `!nuevo …`\.$/);
});

test("an !aparte thread reply while awaiting an answer is ignored entirely", async () => {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;
  await processBatch(f.deps, [question]);
  const postsBefore = f.posts.length;

  const handled = await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.5", text: "!aparte che, ¿le decimos Hola?" });

  assert.equal(handled, true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reactions, []);
  assert.equal(f.posts.length, postsBefore);
  assert.equal(f.store.data.jobs[job.id].state.kind, "awaiting_answer");
});

test("an !aparte mention does nothing, and !ayuda posts the command list", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await handleMention(f.deps, { ...followUpMention, text: "esto no es para vos", command: "aparte" });
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.calls, []);

  await handleMention(f.deps, { ...followUpMention, text: "", command: "ayuda" });
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0], /`!pregunta/);
  assert.deepEqual(f.calls, []);
});

const stopMention = { channel: "C1", threadTs: "100.1", ts: "100.7", user: "U1", text: "", command: "parar" as const };

test("!parar stops the active worker once, records its session, and says where the work stays", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await handleMention(f.deps, stopMention);

  assert.deepEqual(f.calls, ["stop d1"]);
  const job = f.store.data.jobs["C1:100.1"];
  assert.deepEqual(job.state, { kind: "cancelled" });
  assert.equal(job.sessionId, "sess-1");
  assert.deepEqual(f.posts, ["⏹️ cancelado. El trabajo queda en la rama `api-issue-5` por si querés retomarlo (mencioname en este hilo)."]);
});

test("!parar with nothing running says so and stops nothing", async () => {
  for (const job of [doneJob("sess-1"), undefined]) {
    const f = fakes();
    if (job) f.store.data.jobs[job.id] = job;

    await handleMention(f.deps, stopMention);

    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.posts, ["No hay nada corriendo en este hilo."]);
    if (job) assert.equal(f.store.data.jobs[job.id].state.kind, "done");
  }
});

test("when worker-stop fails the job keeps running and the thread is told", async () => {
  const f = fakes({
    async stopWorker() {
      throw new Error("dispatch busy");
    },
  });
  f.store.data.jobs["C1:100.1"] = workingJob();

  await handleMention(f.deps, stopMention);

  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "working");
  assert.match(f.posts.at(-1)!, /❌ no pude parar el worker \(dispatch busy\)/);
});

test("!parar during a start waits for the dispatch, then stops it", async () => {
  let started: (() => void) | undefined;
  const f = fakes({
    async startWorker() {
      await new Promise<void>((resolve) => (started = resolve));
      return { taskId: "t1", dispatchId: "d1", worktreeId: "r1::/wt/api" };
    },
  });
  const start = handleMention(f.deps, { channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "arreglá", target: { owner: "acme", name: "api", source: "link" } });
  const stop = handleMention(f.deps, { ...stopMention, threadTs: "1.1", ts: "1.2" });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(f.calls, [], "nothing is stopped before the dispatch exists");
  started();
  await Promise.all([start, stop]);

  assert.deepEqual(f.calls, ["stop d1"]);
  assert.equal(f.store.data.jobs["C1:1.1"].state.kind, "cancelled");
});

test("a worker_done after a cancel posts nothing but is processed and released", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();
  await handleMention(f.deps, stopMention);
  const posts = f.posts.length;

  await processBatch(f.deps, [{ id: "m7", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) }]);

  assert.equal(f.posts.length, posts);
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "cancelled");
  assert.ok(f.store.data.processedMsgIds.includes("m7"));
  assert.deepEqual(f.calls, ["stop d1", "release d1"]);
});

test("a mention after a cancel resumes the cancelled worker's session", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();
  await handleMention(f.deps, stopMention);

  await handleMention(f.deps, { ...followUpMention, text: "seguí, pero sin tocar el login" });

  const job = f.store.data.jobs["C1:100.1"];
  assert.deepEqual(f.calls.slice(1), ["terminal r1::/wt/api claude --dangerously-skip-permissions --resume sess-1", "wait term-1", "resume term-1"]);
  assert.equal(job.state.kind, "working");
  assert.equal(job.request, "seguí, pero sin tocar el login");
});

function status(id: string, body: string, dispatchId = "d1"): InboxMessage {
  return { id, type: "status", subject: "Avance", body, payload: JSON.stringify({ taskId: "t1", dispatchId, phase: "milestone" }) };
}

test("a status posts once as ⏳, even when the batch replays", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await processBatch(f.deps, [status("s1", "Reproduje el bug.")]);
  await processBatch(f.deps, [status("s1", "Reproduje el bug.")]);

  assert.deepEqual(f.posts, ["⏳ Reproduje el bug."]);
});

test("a long status is trimmed to 300 characters", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await processBatch(f.deps, [status("s1", "x".repeat(400))]);

  assert.equal(f.posts[0], `⏳ ${"x".repeat(300)}…`);
});

test("statuses within 60s of the last post are held back; only the newest posts once the interval passes", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await processBatch(f.deps, [status("s1", "Reproduje el bug.")]);
  f.clock.now += 10_000;
  await processBatch(f.deps, [status("s2", "Encontré la causa.")]);
  f.clock.now += 10_000;
  await processBatch(f.deps, [status("s3", "Fix implementado.")]);
  assert.deepEqual(f.posts, ["⏳ Reproduje el bug."]);

  f.clock.now += 30_000;
  await processBatch(f.deps, []);
  assert.equal(f.posts.length, 1, "still inside the interval");

  f.clock.now += 11_000;
  await processBatch(f.deps, []);
  await processBatch(f.deps, []);
  assert.deepEqual(f.posts, ["⏳ Reproduje el bug.", "⏳ Fix implementado."]);
});

test("a status for a job that is no longer active is ignored, and so is its held-back one", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();
  await processBatch(f.deps, [status("s1", "Reproduje el bug.")]);
  f.clock.now += 5_000;
  await processBatch(f.deps, [status("s2", "Encontré la causa.")]);

  await processBatch(f.deps, [{ id: "m8", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) }]);
  f.clock.now += 120_000;
  await processBatch(f.deps, [status("s3", "Tests pasando.")]);

  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0], "⏳ Reproduje el bug.");
  assert.match(f.posts[1], /^✅/);
  assert.ok(f.store.data.processedMsgIds.includes("s3"));
});

const askMention = {
  channel: "C1",
  threadTs: "100.1",
  ts: "100.8",
  user: "U1",
  text: "¿dónde se valida el token?",
  command: "pregunta" as const,
  target: { owner: "acme", name: "api", source: "link" as const },
};

test("!pregunta answers in the thread from the repo checkout without creating or touching a job", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = workingJob();

  await handleMention(f.deps, askMention);

  assert.deepEqual(f.calls, ["repo-path r1", "ask /repos/api ¿dónde se valida el token?"]);
  assert.deepEqual(f.reactions, ["100.8:eyes"]);
  assert.deepEqual(f.posts, ["*Respuesta*\nSe valida en *src/webhook.ts:12*."]);
  assert.deepEqual(Object.keys(f.store.data.jobs), ["C1:100.1"]);
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "working");
});

test("!pregunta with no repo asks for one, and a failed answer says why", async () => {
  const f = fakes({
    async repoPath() {
      throw new Error("repo gone");
    },
  });

  await handleMention(f.deps, { ...askMention, target: undefined });
  assert.match(f.posts[0], /no sé de qué repo es la pregunta/);

  await handleMention(f.deps, askMention);
  assert.equal(f.posts[1], "❌ no pude responder: repo gone");
  assert.deepEqual(f.store.data.jobs, {});
});
