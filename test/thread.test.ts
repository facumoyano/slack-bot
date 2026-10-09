import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/blocks.ts";
import { EXIT_TIMEOUT, UsageError, matchUser, parseCommand, run, threadForCwd, waitForReply } from "../src/thread.ts";
import type { Clock, SlackApi, SlackUser, Thread, ThreadMsg } from "../src/thread.ts";

const job = (channel: string, threadTs: string, path?: string) => ({ slack: { channel, threadTs }, worktreeId: path && `repo-id::${path}` });

test("a cwd finds its job's thread by worktree: exact toplevel, nested dir, the deepest of several", () => {
  const jobs = {
    a: job("C1", "1.1", "/w/api-issue-1"),
    b: job("C2", "2.2", "/w/web-issue-2"),
    c: job("C3", "3.3"),
    d: job("C4", "4.4", "/w/api-issue-1/packages/sub"),
  };
  assert.deepEqual(threadForCwd(jobs, "/w/web-issue-2", "/w/web-issue-2"), { channel: "C2", threadTs: "2.2" });
  assert.deepEqual(threadForCwd(jobs, undefined, "/w/web-issue-2/src/deep"), { channel: "C2", threadTs: "2.2" });
  assert.deepEqual(threadForCwd(jobs, "/w/api-issue-1", "/w/api-issue-1/src"), { channel: "C1", threadTs: "1.1" });
  assert.deepEqual(threadForCwd(jobs, "/w/api-issue-1", "/w/api-issue-1/packages/sub/x"), { channel: "C4", threadTs: "4.4" });
});

test("a cwd outside every worktree, or a sibling with a shared prefix, asks for --thread", () => {
  const jobs = { a: job("C1", "1.1", "/w/api-issue-1") };
  assert.throws(() => threadForCwd(jobs, "/w/api-issue-10", "/w/api-issue-10"), /pasá --thread/);
  assert.throws(() => threadForCwd({}, undefined, "/tmp"), UsageError);
});

test("one worktree in two threads is ambiguous and names both", () => {
  const jobs = { a: job("C1", "1.1", "/w/x"), b: job("C2", "2.2", "/w/x") };
  assert.throws(() => threadForCwd(jobs, "/w/x", "/w/x"), /C1:1\.1.*C2:2\.2/);
});

const user = (id: string, name: string, displayName = "", realName = "", over: Partial<SlackUser> = {}): SlackUser => ({
  id,
  name,
  displayName,
  realName,
  isBot: false,
  deleted: false,
  ...over,
});

const people = [
  user("U1", "salva", "Salva", "Salvador Pérez"),
  user("U2", "nora.g", "Nora", "Nora Gómez"),
  user("U3", "nicolas", "Nico", "Nicolás Ruiz"),
  user("U4", "nicanor", "", "Nicanor Paz"),
  user("U5", "salva.old", "salva", "", { deleted: true }),
  user("B1", "alfred", "Alfred", "", { isBot: true }),
  user("B2", "nora-bot", "nora", "", { isBot: true }),
];

test("users resolve by id, @name, display or real name, ignoring case and accents", () => {
  assert.equal(matchUser(people, "U0ABCDEF12").id, "U0ABCDEF12");
  assert.throws(() => matchUser(people, "UX"), /no encontré a "UX"/);
  assert.equal(matchUser(people, "@salva").id, "U1");
  assert.equal(matchUser(people, "SALVA").id, "U1");
  assert.equal(matchUser(people, "nora").id, "U2");
  assert.equal(matchUser(people, "nicolas ruiz").id, "U3");
  assert.equal(matchUser(people, "Nicolás").id, "U3");
  assert.equal(matchUser(people, "alfred").id, "B1");
});

test("a unique prefix resolves; a shared one is ambiguous and lists the candidates; none says so", () => {
  assert.equal(matchUser(people, "salvador").id, "U1");
  assert.equal(matchUser(people, "nica").id, "U4");
  assert.throws(() => matchUser(people, "ni"), /ambiguo.*U3.*U4|ambiguo.*U4.*U3/);
  assert.throws(() => matchUser(people, "zoe"), /no encontré a "zoe"/);
});

test("argument parsing: post needs exactly one text source, wait needs --from, options stay with their command", () => {
  assert.deepEqual(parseCommand(["post", "--to", "@salva", "--to", "nora", "--text-file", "/tmp/m.md", "--thread", "C1:1.2"]), {
    kind: "post",
    thread: { channel: "C1", threadTs: "1.2" },
    state: undefined,
    to: ["@salva", "nora"],
    text: { file: "/tmp/m.md" },
    files: [],
    dryRun: false,
  });
  assert.throws(() => parseCommand(["post", "--to", "salva"]), /--text/);
  assert.throws(() => parseCommand(["post", "--text", "a", "--text-file", "b"]), /no los dos/);
  assert.throws(() => parseCommand(["post", "hola"]), /--text/);
  assert.throws(() => parseCommand(["read", "--to", "salva"]), /--to no aplica a read/);
  assert.throws(() => parseCommand(["wait"]), /--from/);
  assert.throws(() => parseCommand(["wait", "--from", "x", "--timeout", "0"]), /--timeout/);
  assert.throws(() => parseCommand(["read", "--thread", "C1"]), /<canal>:<ts>/);
  assert.throws(() => parseCommand(["borrar"]), /comando desconocido/);
  const wait = parseCommand(["wait", "--from", "salva"]);
  assert.equal(wait.kind === "wait" && wait.timeoutMinutes, 30);
  assert.deepEqual(parseCommand(["read", "--since", "5.1", "--all"]), { kind: "read", thread: undefined, state: undefined, since: "5.1", from: undefined, all: true });
});

const thread: Thread = { channel: "C1", threadTs: "100.000001" };
const self = { userId: "UBOT", botId: "BBOT" };

function fakeApi(replies: ThreadMsg[][] = [[]]) {
  const posted: Message[] = [];
  const uploaded: string[] = [];
  let polls = 0;
  const api: SlackApi = {
    self: async () => self,
    users: async () => people,
    replies: async () => replies[Math.min(polls++, replies.length - 1)],
    post: async (_t, m) => {
      posted.push(m);
      return `200.${posted.length}`;
    },
    permalink: async (_c, ts) => `https://x.slack.com/p${ts}`,
    upload: async (_t, path) => {
      uploaded.push(path);
    },
  };
  return { api, posted, uploaded, polls: () => polls };
}

function fakeClock(start = 1_000_000_000): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

async function runWith(argv: string[], api: SlackApi, clock = fakeClock()) {
  const lines: string[] = [];
  const code = await run(parseCommand(argv), { api, clock, out: (l) => lines.push(l), findThread: async () => thread });
  return { code, out: lines.join("\n") };
}

test("post mentions the --to users first, renders Markdown as mrkdwn, uploads files and prints ts and permalink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thread-"));
  await writeFile(join(dir, "m.md"), "**Decisiones**\n- usar [el PR](https://github.com/o/r/pull/7)\n");
  await writeFile(join(dir, "diagrama.png"), "png");
  const { api, posted, uploaded } = fakeApi();
  const { code, out } = await runWith(["post", "--to", "salva", "--to", "@Nora", "--text-file", join(dir, "m.md"), "--file", join(dir, "diagrama.png")], api);
  assert.equal(code, 0);
  assert.deepEqual(
    posted.map((p) => p.text),
    ["<@U1> <@U2> *Decisiones*\n• usar <https://github.com/o/r/pull/7|el PR>"],
  );
  assert.deepEqual(uploaded, [join(dir, "diagrama.png")]);
  assert.match(out, /ts: 200\.1\npermalink: https:\/\/x\.slack\.com\/p200\.1/);
});

test("a long post is split into several messages on line breaks, losing nothing", async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `- línea ${i} ${"x".repeat(40)}`);
  const { api, posted } = fakeApi();
  await runWith(["post", "--to", "salva", "--text", lines.join("\n")], api);
  assert.ok(posted.length > 1, `${posted.length} messages`);
  assert.ok(posted.every((p) => p.text.length <= 39_000));
  assert.equal(posted.map((p) => p.text).join("\n"), `<@U1>\n${lines.map((l) => l.replace(/^- /, "• ")).join("\n")}`);
  assert.ok(!posted[1].text.includes("<@U1>"));
});

test("--dry-run prints what it would post and posts nothing", async () => {
  const { api, posted } = fakeApi();
  const { code, out } = await runWith(["post", "--to", "salva", "--text", "¿Va?", "--dry-run"], api);
  assert.equal(code, 0);
  assert.deepEqual(posted, []);
  assert.match(out, /no se postea[^]*<@U1> ¿Va\?/);
});

test("a missing attachment fails before anything is posted", async () => {
  const { api, posted } = fakeApi();
  await assert.rejects(runWith(["post", "--text", "hola", "--file", "/no/existe.png"], api), /no existe el archivo/);
  assert.deepEqual(posted, []);
});

const msg = (ts: string, user: string | undefined, text: string, over: Partial<ThreadMsg> = {}): ThreadMsg => ({ ts, user, text, files: [], ...over });

test("read lists people's messages oldest first with names and files, the bot's own only with --all", async () => {
  const replies = [
    msg("100.000001", "U9", "pedido original"),
    msg("101.5", "UBOT", "listo, PR abierto", { botId: "BBOT" }),
    msg("103.0", "U2", "a mí también"),
    msg("102.0", "U1", "me parece bien", { files: ["nota.pdf"] }),
  ];
  const { out } = await runWith(["read", "--since", "100.5"], fakeApi([replies]).api);
  assert.equal(out, "hilo: C1:100.000001\n[102.0] Salva: me parece bien\n📎 nota.pdf\n[103.0] Nora: a mí también");
  const all = await runWith(["read", "--all"], fakeApi([replies]).api);
  assert.match(all.out, /listo, PR abierto/);
});

test("wait returns once the target user posts after since, ignoring others and the bot", async () => {
  const before = [msg("100.000001", "U9", "pedido"), msg("150.0", "U1", "respuesta vieja")];
  const noise = [...before, msg("300.0", "UBOT", "<@U1> ¿va?", { botId: "BBOT" }), msg("310.0", "U2", "yo opino otra cosa")];
  const answered = [...noise, msg("320.0", "U1", "dale, aprobado")];
  const fake = fakeApi([before, noise, answered]);
  const clock = fakeClock();
  const { code, out } = await runWith(["wait", "--from", "salva", "--since", "200.0"], fake.api, clock);
  assert.equal(code, 0);
  assert.equal(fake.polls(), 3);
  assert.deepEqual(clock.slept, [20_000, 20_000]);
  assert.match(out, /\[320\.0\] Salva: dale, aprobado$/);
  assert.doesNotMatch(out, /respuesta vieja|otra cosa/);
});

test("wait defaults since to now and times out with exit code 2", async () => {
  const fake = fakeApi([[msg("999.0", "U1", "antes de esperar")]]);
  const clock = fakeClock(1_000_000_000);
  const { code, out } = await runWith(["wait", "--from", "salva", "--timeout", "1"], fake.api, clock);
  assert.equal(code, EXIT_TIMEOUT);
  assert.equal(clock.slept.reduce((a, b) => a + b, 0), 60_000);
  assert.match(out, /sin respuesta de Salva en 1 min/);
});

test("waitForReply stops polling at the deadline even when it falls between polls", async () => {
  const fake = fakeApi([[]]);
  const clock = fakeClock(0);
  const found = await waitForReply(fake.api, { thread, self, from: "U1", since: "0", timeoutMs: 50_000 }, clock);
  assert.equal(found, undefined);
  assert.deepEqual(clock.slept, [20_000, 20_000, 10_000]);
});
