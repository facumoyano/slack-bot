import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMention, handleThreadReply } from "../src/bot.ts";
import type { BotDeps, Poster } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxDeps } from "../src/inbox.ts";
import { newJob, transition } from "../src/jobs.ts";
import type { InboxMessage, Job } from "../src/jobs.ts";
import type { Orca } from "../src/orca.ts";
import { memoryStore } from "../src/store.ts";

function fakes(over: Partial<Orca> = {}) {
  const posts: string[] = [];
  const specs: string[] = [];
  const reactions: string[] = [];
  const calls: string[] = [];
  const poster: Poster = {
    async postToThread(_job, text) {
      posts.push(text);
    },
    async react(_c, ts, name) {
      reactions.push(`${ts}:${name}`);
    },
    async postTopLevel(_c, text) {
      posts.push(`[top] ${text}`);
      return "200.1";
    },
  };
  const orca: Orca = {
    async startWorker(o) {
      calls.push(`start ${o.name}`);
      return { taskId: "t1", dispatchId: "d1", worktreeId: "r1::/wt/api" };
    },
    async startFollowUp(o) {
      calls.push(`followup ${o.worktreeId}`);
      specs.push(o.spec);
      return { taskId: "t2", dispatchId: "d2", worktreeId: o.worktreeId };
    },
    async createTerminal(o) {
      calls.push(`terminal ${o.worktreeId} ${o.command}`);
      return "term-1";
    },
    async waitTuiIdle(handle) {
      calls.push(`wait ${handle}`);
      return true;
    },
    async closeTerminal(handle) {
      calls.push(`close ${handle}`);
    },
    async startWorkerInTerminal(o) {
      calls.push(`resume ${o.handle}`);
      specs.push(o.spec);
      return { taskId: "t3", dispatchId: "d3", worktreeId: o.worktreeId };
    },
    async stopWorker(id) {
      calls.push(`stop ${id}`);
    },
    async checkInbox() {
      return { messages: [], timedOut: true };
    },
    async reply(id, body) {
      calls.push(`reply ${id} ${body}`);
    },
    async send(id, body) {
      calls.push(`send ${id} ${body}`);
    },
    async release(id) {
      calls.push(`release ${id}`);
    },
    async lookupPrUrl() {
      calls.push("lookup");
      return "https://github.com/acme/api/pull/99";
    },
  };
  const store = memoryStore();
  const sessions: Record<string, string> = { "/wt/api": "sess-1" };
  const deps: BotDeps & InboxDeps = {
    orca: { ...orca, ...over },
    poster,
    store,
    resolveRepo: async () => "r1",
    async latestSession(path) {
      return sessions[path];
    },
  };
  return { posts, reactions, calls, specs, store, deps, sessions };
}

function workingJob(): Job {
  const job = newJob({
    slack: { channel: "C1", threadTs: "100.1", requester: "U1" },
    repo: { owner: "acme", name: "api", orcaRepoId: "r1" },
    issue: { number: 5, url: "https://github.com/acme/api/issues/5" },
    request: "arreglalo",
  });
  return transition(job, { kind: "started", worktreeId: "r1::/wt/api", taskId: "t1", dispatchId: "d1" })!;
}

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
    assert.equal(f.posts.at(-1), `Este hilo es de acme/api#5. Si querés que tome ${other} como tarea aparte, escribí <@UBOT> \`nuevo …\`.`);
  }
});

test("nuevo inside a thread opens a new thread and keys the new job by its ts", async () => {
  const f = fakes();
  f.store.data.jobs["C1:100.1"] = doneJob("sess-1");

  await handleMention(f.deps, {
    ...followUpMention,
    text: "sumá tests a acme/web",
    newTask: true,
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

  assert.match(f.posts[0], /🫡 tomo el pedido en acme\/api \(lo deduje del hilo; si no es ese, decime cuál\)/);
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
  assert.match(f.posts.at(-1)!, /^Este hilo es de acme\/api#5\. .*mencioname con `nuevo …`\.$/);
});
