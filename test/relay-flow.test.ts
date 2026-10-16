import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expireRelays, handleDm, handleMention, handleThreadReply } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import { RELAY_REPLY_TTL_MS, isResumable, newJob, transition } from "../src/jobs.ts";
import type { InboxMessage, Job } from "../src/jobs.ts";
import { relayPath } from "../src/report.ts";
import { openStore } from "../src/store.ts";
import { fakes } from "./fakes.ts";

const CHANNEL = "CRELAY";
const THREAD = "1791548002.024869";
const ID = `${CHANNEL}:${THREAD}`;
const LINK = `https://acme.slack.com/archives/${CHANNEL}/p1791548002024869`;
const THREAD_LINK = `https://slack.test/${CHANNEL}/${THREAD}`;
const RESUME = ["terminal path:/wt/api claude --dangerously-skip-permissions --resume sess-1", "wait term-1", "resume term-1"];

function doneJob(): Job {
  const job = newJob({
    slack: { channel: CHANNEL, threadTs: THREAD, requester: "U1" },
    repo: { owner: "acme", name: "api", orcaRepoId: "r1" },
    issue: { number: 486, url: "https://github.com/acme/api/pull/486" },
    request: "guardá los permisos",
    mode: "change",
  });
  const working = transition(job, { kind: "started", worktreeId: "r1::/wt/api", taskId: "t1", dispatchId: "d1" })!;
  return transition(working, { kind: "worker_done", outcome: "succeeded", summary: "Guardé los permisos.", prUrl: "https://github.com/acme/api/pull/486", sessionId: "sess-1" })!;
}

function setup(store?: ReturnType<typeof openStore>) {
  const f = fakes();
  if (store) f.deps.store = store;
  f.deps.store.data.jobs[ID] = doneJob();
  return f;
}

let dmCount = 0;
/** A top-level DM, or one written inside the DM thread `threadTs`. */
const ownerDm = (user: string, text: string, threadTs?: string) => ({ user, text, channel: `D-${user}`, ts: `500.${++dmCount}`, ...(threadTs ? { threadTs } : {}) });

const done = (id: string, outcome = "succeeded"): InboxMessage => ({ id, type: "worker_done", body: "listo", payload: JSON.stringify({ dispatchId: "d3", outcome }) });

async function workerWrites(text: string): Promise<void> {
  await mkdir(dirname(relayPath(ID)), { recursive: true });
  await writeFile(relayPath(ID), text);
}

const ASK = `await: <@U0SALVA01>\n\n<@U0SALVA01> en el PR #486 guardé los permisos en \`agents\` porque:\n- **src/perms.ts:12** los lee con el agente\n\n¿Te parece bien?`;

/** Returns the owner's DM, whose ts roots the DM thread every answer goes to. */
async function askedSalva(f: ReturnType<typeof setup>) {
  const dm = ownerDm("U1", `<${LINK}> preguntale a @salva por qué guardó los permisos en la tabla de agentes`);
  await handleDm(f.deps, dm);
  await workerWrites(ASK);
  await processBatch(f.deps, [done("w-ask")]);
  return dm;
}

test("an owner's DM resumes the thread's session with the instruction and the named people's tokens, posting nothing in the thread", async () => {
  const f = setup();

  await handleDm(f.deps, ownerDm("U1", `<${LINK}|hilo> preguntale a @salva por qué guardó los permisos en la tabla de agentes`));

  assert.deepEqual(f.calls, RESUME);
  assert.match(f.specs[0], /PRIVATE INSTRUCTION[\s\S]*preguntale a @salva por qué guardó los permisos en la tabla de agentes/);
  assert.match(f.specs[0], /Salva: `<@U0SALVA01>`/);
  assert.match(f.specs[0], new RegExp(relayPath(ID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(f.specs[0], /gh pr create/);
  assert.deepEqual([f.posts, f.reactions], [[], []], "the thread sees nothing");
  assert.deepEqual(f.dms.map((d) => [d.user, d.text]), [["U1", `👌 voy con eso en ${THREAD_LINK}`]]);
  assert.equal(f.store.data.jobs[ID].state.kind, "relaying");
});

test("a teammate's or a stranger's DM gets nothing at all", async () => {
  const f = setup();

  await handleDm(f.deps, ownerDm("T1", `${LINK} avisale a @sebas`));
  await handleDm(f.deps, ownerDm("U9", `${LINK} avisale a @sebas`));

  assert.deepEqual([f.dms, f.posts, f.calls], [[], [], []]);
  assert.equal(f.store.data.jobs[ID].state.kind, "done");
});

test("an owner's DM without a link, for an unknown thread, or for a busy one gets the matching DM and runs nothing", async () => {
  const f = setup();
  f.deps.store.data.jobs["CRELAY:1791548003.000001"] = {
    ...doneJob(),
    id: "CRELAY:1791548003.000001",
    slack: { channel: CHANNEL, threadTs: "1791548003.000001", requester: "U1" },
    state: { kind: "working" },
    dispatchId: "d9",
  };

  await handleDm(f.deps, ownerDm("U1", "preguntale a @salva"));
  await handleDm(f.deps, ownerDm("U1", "https://acme.slack.com/archives/COTHER/p1791548002024869 preguntale a @salva"));
  await handleDm(f.deps, ownerDm("U1", "https://acme.slack.com/archives/CRELAY/p1791548003000001 preguntale a @salva"));

  assert.match(f.dms[0].text, /^Pegá el link de un mensaje del hilo y qué querés que haga/);
  assert.equal(f.dms[1].text, "no tengo un trabajo en ese hilo");
  assert.equal(f.dms[2].text, `ese hilo está trabajando ahora; mandámelo cuando termine (https://slack.test/${CHANNEL}/1791548003.000001)`);
  assert.deepEqual([f.posts, f.calls], [[], []]);
});

test("a name nobody in Slack has still runs, and only a thread message for that person is refused, by DM", async () => {
  const f = setup();

  await handleDm(f.deps, ownerDm("U1", `${LINK} preguntale a @zoe si le parece bien`));
  assert.deepEqual(f.calls, RESUME, "the unknown name does not block the run");
  assert.match(f.specs[0], /match nobody in Slack[^\n]*`zoe`/);
  await workerWrites("await: @zoe\n\n@zoe ¿te parece bien?");
  await processBatch(f.deps, [done("w-zoe")]);

  assert.deepEqual(f.posts, []);
  assert.match(f.dms.at(-1)!.text, new RegExp(`^❌ no pude escribir en ${THREAD_LINK}: no encontré a "zoe" en Slack`));
  assert.deepEqual(f.store.data.jobs[ID].state, doneJob().state);
});

test("an owner's private question gets a private answer by DM and the thread sees nothing", async () => {
  const f = setup();

  const dm = ownerDm("U1", `${LINK} ¿por qué elegiste guardar los permisos en la tabla de agentes?`);
  await handleDm(f.deps, dm);
  assert.match(f.specs[0], /PRIVATE INSTRUCTION[\s\S]*¿por qué elegiste guardar los permisos/);
  await workerWrites("private\n\nPorque **src/perms.ts:12** los lee junto con el agente.");
  await processBatch(f.deps, [done("w-private")]);

  assert.deepEqual([f.posts, f.reactions], [[], []], "nothing in the thread");
  assert.equal(f.dms.at(-1)!.text, `💬 en ${THREAD_LINK}:\n\nPorque *src/perms.ts:12* los lee junto con el agente.`);
  assert.deepEqual(f.dms.map((d) => d.threadTs), [dm.ts, dm.ts], "the ack and the answer reply in the owner's DM thread");
  assert.ok(f.calls.includes("release d3"));
  assert.deepEqual(f.store.data.jobs[ID].state, doneJob().state, "back to the thread's own finished run");
  assert.ok(isResumable(f.store.data.jobs[ID]));
});

test("a DM without a link continues the owner's last thread in the same session, until a link switches it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "relay-store-")), "state.json");
  const f = setup(openStore(path));
  const OTHER = "1791548003.000001";
  f.deps.store.data.jobs[`${CHANNEL}:${OTHER}`] = { ...doneJob(), id: `${CHANNEL}:${OTHER}`, slack: { channel: CHANNEL, threadTs: OTHER, requester: "U1" }, sessionId: "sess-9" };

  await handleDm(f.deps, ownerDm("U1", `${LINK} ¿qué quedó pendiente?`));
  await workerWrites("private\n\nQueda mover la tabla.");
  await processBatch(f.deps, [done("w-1")]);
  f.deps.store = openStore(path);
  await handleDm(f.deps, ownerDm("U1", "dale, escribile a @salva lo que hablamos"));

  assert.equal(f.dms.at(-1)!.text, `👌 voy con eso en ${THREAD_LINK}`);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("terminal")), [RESUME[0], RESUME[0]], "both steps resume the thread's own session");
  assert.match(f.specs.at(-1)!, /PRIVATE INSTRUCTION[\s\S]*dale, escribile a @salva lo que hablamos/);
  assert.match(f.specs.at(-1)!, /Salva: `<@U0SALVA01>`/);
  await workerWrites("await: none\n\n<@U0SALVA01> queda pendiente mover la tabla de permisos.");
  await processBatch(f.deps, [done("w-2")]);
  assert.deepEqual(f.posts, ["<@U0SALVA01> queda pendiente mover la tabla de permisos."]);

  await handleDm(f.deps, ownerDm("U1", `https://acme.slack.com/archives/${CHANNEL}/p1791548003000001 ¿y acá?`));
  await handleDm(f.deps, ownerDm("U1", "¿algo más?"));
  assert.equal(openStore(path).data.lastThreadByOwner.U1, `${CHANNEL}:${OTHER}`, "the new link switched the thread, also on disk");
  assert.equal(f.dms.at(-1)!.text, `ese hilo está trabajando ahora; mandámelo cuando termine (https://slack.test/${CHANNEL}/${OTHER})`, "the linkless DM went to the new thread");
  assert.match(f.calls.at(-3)!, /--resume sess-9$/);
  await rm(dirname(path), { recursive: true, force: true });
});

test("a DM inside an earlier DM thread goes to that thread's work and session, even after another link, and answers there", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "relay-store-")), "state.json");
  const f = setup(openStore(path));
  const OTHER = "1791548003.000001";
  f.deps.store.data.jobs[`${CHANNEL}:${OTHER}`] = { ...doneJob(), id: `${CHANNEL}:${OTHER}`, slack: { channel: CHANNEL, threadTs: OTHER, requester: "U1" }, sessionId: "sess-9" };

  const first = ownerDm("U1", `${LINK} ¿qué quedó pendiente?`);
  await handleDm(f.deps, first);
  await workerWrites("private\n\nQueda mover la tabla.");
  await processBatch(f.deps, [done("w-1")]);
  await handleDm(f.deps, ownerDm("U1", `https://acme.slack.com/archives/${CHANNEL}/p1791548003000001 ¿y acá?`));
  await workerWrites("private\n\nAcá nada.");
  await processBatch(f.deps, [done("w-2")]);
  f.deps.store = openStore(path);
  const sent = f.dms.length;

  await handleDm(f.deps, ownerDm("U1", "dale, escribile a @salva lo que hablamos", first.ts));

  assert.deepEqual(f.dms.slice(sent).map((d) => [d.text, d.threadTs]), [[`👌 voy con eso en ${THREAD_LINK}`, first.ts]]);
  assert.match(f.calls.filter((c) => c.startsWith("terminal")).at(-1)!, /--resume sess-1$/, "the first thread's session, not the last link's");
  assert.equal(f.deps.store.data.jobs[ID].state.kind, "relaying");
  await rm(dirname(path), { recursive: true, force: true });
});

test("an owner's first DM ever without a link gets the usage", async () => {
  const f = setup();
  await handleDm(f.deps, ownerDm("U1", "¿qué quedó pendiente?"));
  assert.match(f.dms[0].text, /^Pegá el link de un mensaje del hilo/);
  assert.deepEqual(f.calls, []);
});

test("the first step's message goes to the thread exactly as written, and the wait for salva survives a restart", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "relay-store-")), "state.json");
  const f = setup(openStore(path));

  await askedSalva(f);

  assert.deepEqual(f.posts, ["<@U0SALVA01> en el PR #486 guardé los permisos en `agents` porque:\n• *src/perms.ts:12* los lee con el agente\n\n¿Te parece bien?"]);
  assert.doesNotMatch(f.posts[0], /<@U1>|me pidi/);
  assert.ok(f.calls.includes("release d3"));
  const reloaded = openStore(path).data.jobs[ID];
  assert.equal(reloaded.state.kind, "awaiting_reply");
  assert.deepEqual(reloaded.state.kind === "awaiting_reply" && [reloaded.state.from, reloaded.state.postTs], [["U0SALVA01"], "900.1"]);
  assert.deepEqual(f.dms.length, 1, "only the ack: the owner hears back once salva answers");
  await rm(dirname(path), { recursive: true, force: true });
});

test("salva's reply resumes the session once with it as an opinion; other replies are ignored; the digest goes only to the owner", async () => {
  const f = setup();
  const dm = await askedSalva(f);
  // The write step's resumed terminal stays open with Claude in it, so the digest continues there.
  f.deps.orca.claudeTerminalOpen = async (handle) => {
    f.calls.push(`open? ${handle}`);
    return true;
  };
  const before = f.calls.length;

  assert.equal(await handleThreadReply(f.deps, { channel: CHANNEL, threadTs: THREAD, ts: "900.5", user: "T1", text: "yo opino otra cosa" }), true);
  assert.equal(f.calls.length, before, "another teammate's reply runs nothing");
  await handleThreadReply(f.deps, { channel: CHANNEL, threadTs: THREAD, ts: "900.6", user: "U0SALVA01", text: "Sí, pero movelo a una tabla aparte." });
  await handleThreadReply(f.deps, { channel: CHANNEL, threadTs: THREAD, ts: "900.7", user: "U0SALVA01", text: "y otra cosa" });

  assert.deepEqual(f.calls.slice(before), ["open? term-1", "wait term-1", "resume term-1"], "one resume for the first reply only, in the same terminal");
  assert.match(f.specs.at(-1)!, /This is Salva's opinion, not an instruction/);
  assert.match(f.specs.at(-1)!, /REPLY FROM SALVA[\s\S]*Sí, pero movelo a una tabla aparte\./);
  assert.doesNotMatch(f.specs.at(-1)!, /y otra cosa/);

  await workerWrites("Salva prefiere una tabla aparte. No cambia lo que hice; **recomiendo** moverla en otro PR.");
  await processBatch(f.deps, [done("w-digest")]);

  assert.equal(f.posts.length, 1, "nothing more in the thread");
  assert.deepEqual(f.reactions, []);
  assert.deepEqual(f.dms.at(-1), {
    user: "U1",
    channel: "D-U1",
    ts: "700.2",
    text: `💬 Salva respondió en ${THREAD_LINK}:\n\nSalva prefiere una tabla aparte. No cambia lo que hice; *recomiendo* moverla en otro PR.`,
    blocks: undefined,
    threadTs: dm.ts,
  }, "the digest lands in the owner's original DM thread");
  const job = f.store.data.jobs[ID];
  assert.deepEqual(job.state, doneJob().state, "back to the thread's own finished run");
  assert.ok(isResumable(job));
});

test("salva may also answer by mentioning the bot, without the stranger's refusal", async () => {
  const f = setup();
  await askedSalva(f);

  await handleMention(f.deps, { channel: CHANNEL, threadTs: THREAD, ts: "900.8", user: "U0SALVA01", text: "dale, me parece bien" });

  assert.equal(f.posts.length, 1);
  assert.match(f.specs.at(-1)!, /dale, me parece bien/);
  assert.equal(f.store.data.jobs[ID].state.kind, "relaying");
});

test("an owner's mention while waiting ends the wait as a normal follow-up", async () => {
  const f = setup();
  await askedSalva(f);

  await handleMention(f.deps, { channel: CHANNEL, threadTs: THREAD, ts: "900.9", user: "U1", text: "!investiga otra cosa", command: "investiga" });

  const job = f.store.data.jobs[ID];
  assert.equal(job.state.kind, "working");
  assert.equal(job.mode, "investigate");
  assert.match(f.specs.at(-1)!, /Investigation playbook/);
  await handleThreadReply(f.deps, { channel: CHANNEL, threadTs: THREAD, ts: "901.1", user: "U0SALVA01", text: "tarde" });
  assert.doesNotMatch(f.specs.at(-1)!, /tarde/);
});

test("a plain notice is posted and the owner gets its link", async () => {
  const f = setup();
  await handleDm(f.deps, ownerDm("U1", `${LINK} avisale a @sebas que el PR está listo`));
  await workerWrites("await: none\n\n<@U0SEBAS01> el PR #486 está listo para revisar.");

  await processBatch(f.deps, [done("w-notice")]);

  assert.deepEqual(f.posts, ["<@U0SEBAS01> el PR #486 está listo para revisar."]);
  assert.equal(f.dms.at(-1)!.text, `✅ listo: https://slack.test/${CHANNEL}/900.1`);
  assert.deepEqual(f.store.data.jobs[ID].state, doneJob().state);
});

test("a day without salva's reply is DMed and the job rests again", async () => {
  const f = setup();
  await askedSalva(f);

  await expireRelays(f.deps, f.clock.now + RELAY_REPLY_TTL_MS - 1);
  assert.equal(f.store.data.jobs[ID].state.kind, "awaiting_reply");
  await expireRelays(f.deps, f.clock.now + RELAY_REPLY_TTL_MS);
  await expireRelays(f.deps, f.clock.now + RELAY_REPLY_TTL_MS + 1);

  assert.deepEqual(f.dms.slice(1).map((d) => d.text), [`⌛ Salva no respondió en ${THREAD_LINK}`]);
  assert.deepEqual(f.store.data.jobs[ID].state, doneJob().state);
  assert.equal(f.posts.length, 1);
});

test("a failed relay, a malformed file or a session that will not resume is DMed, never posted", async () => {
  for (const [label, act] of [
    ["failed outcome", async (f: ReturnType<typeof setup>) => processBatch(f.deps, [done("w-fail", "failed")])],
    ["malformed file", async (f: ReturnType<typeof setup>) => (await workerWrites("<@U0SALVA01> hola sin encabezado"), processBatch(f.deps, [done("w-bad")]))],
  ] as const) {
    const f = setup();
    await handleDm(f.deps, ownerDm("U1", `${LINK} preguntale a @salva`));
    await act(f);
    assert.deepEqual(f.posts, [], label);
    assert.match(f.dms.at(-1)!.text, /^❌ no pude escribir en /, label);
    assert.deepEqual(f.store.data.jobs[ID].state, doneJob().state, label);
  }

  const f = fakes({ async waitTuiIdle() { return false; } });
  f.deps.store.data.jobs[ID] = doneJob();
  await handleDm(f.deps, ownerDm("U1", `${LINK} preguntale a @salva`));
  assert.deepEqual(f.posts, []);
  assert.ok(!f.calls.some((c) => c.startsWith("followup")), "no fresh worker without the session's context");
  assert.match(f.dms.at(-1)!.text, /^❌ no pude retomar la sesión de .*no escribí nada en el hilo\.$/);
  assert.deepEqual(f.store.data.jobs[ID].state, doneJob().state);
});

test("a relay's statuses never reach the thread and its questions are answered without a human", async () => {
  const f = setup();
  await handleDm(f.deps, ownerDm("U1", `${LINK} preguntale a @salva`));

  await processBatch(f.deps, [
    { id: "s1", type: "status", body: "leyendo el PR", payload: JSON.stringify({ dispatchId: "d3" }) },
    { id: "q1", type: "question", body: "¿A quién?", payload: JSON.stringify({ dispatchId: "d3", question: "¿A quién?" }) },
  ]);

  assert.deepEqual(f.posts, []);
  assert.ok(f.calls.some((c) => c.startsWith("reply q1 No human can answer")));
  assert.equal(f.store.data.jobs[ID].state.kind, "relaying");
});

test("a DM that mentions Alfred passes the instruction without the mention", async () => {
  const f = setup();
  f.deps.botUserId = "UALFRED";

  await handleDm(f.deps, ownerDm("U1", `<@UALFRED> <${LINK}> preguntale a @salva si le parece bien`));

  assert.deepEqual(f.calls, RESUME);
  assert.doesNotMatch(f.specs[0], /UALFRED/);
});
