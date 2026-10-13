import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutOf } from "../src/ask.ts";
import { handleDm, handleMention } from "../src/bot.ts";
import type { Mention } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { changedFiles, headSha } from "../src/orca.ts";
import { reportPath } from "../src/report.ts";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fakes } from "./fakes.ts";

const MKT = "/home/facu/orca/projects/mkt-fyso";
const CH = "CMKT0001";

function bound(over: Parameters<typeof fakes>[0] = {}) {
  const f = fakes(over);
  f.deps.dirs = { [CH]: { name: "mkt-fyso", path: MKT } };
  return f;
}

function mention(over: Partial<Mention> = {}): Mention {
  return { channel: CH, threadTs: "300.1", ts: "300.1", user: "U1", text: "creá un archivo notas.md con 3 ideas de posts", ...over };
}

const github = { owner: "acme", name: "api", source: "link" as const, issue: { number: 7, url: "https://github.com/acme/api/issues/7" } };
const done = (id: string, dispatchId: string, body = "Creé notas.md."): InboxMessage => ({ id, type: "worker_done", body, payload: JSON.stringify({ dispatchId, outcome: "succeeded" }) });

test("a mention in a bound channel starts a worker on the directory's own worktree, even when its text links a GitHub issue", async () => {
  const f = bound();

  await handleMention(f.deps, mention({ text: "basate en https://github.com/acme/api/issues/7 y creá notas.md", target: github, ownTarget: github }));

  assert.deepEqual(f.calls, [`resolve-dir ${MKT}`, `head ${MKT}`, `followup path:${MKT}`], "no new worktree, no GitHub repo");
  const job = f.store.data.jobs[`${CH}:300.1`];
  assert.deepEqual(job.repo, { kind: "dir", name: "mkt-fyso", path: MKT, orcaRepoId: "rdir" });
  assert.equal(job.worktreeId, `rdir::${MKT}`);
  assert.equal(job.issue, undefined);
  assert.equal(job.runBase, "base0");
  assert.equal(job.state.kind, "working");
  assert.equal(f.posts[0], "🫡 tomo el pedido en mkt-fyso. Te aviso por acá.");
  const spec = f.specs[0];
  assert.doesNotMatch(spec, /\bgh\b|\bPR\b|push|new-top-level/);
  assert.match(spec, /git add <path> <path> …/);
  assert.match(spec, /Never `git add -A`, `git add \.` or `git commit -a`/);
  assert.match(spec, /Never commit `\.mcp\.json`, `\.claude\/`, `\.agents\/`/);
});

test("!repo in a bound channel shows the directory and refuses to set or clear a repo", async () => {
  const f = bound();
  const repo = (text: string) => handleMention(f.deps, mention({ command: "repo", text }));

  await repo("");
  assert.equal(f.posts.at(-1), `📁 este canal trabaja en la carpeta local mkt-fyso (\`${MKT}\`), sin GitHub.\nRepos que conozco: \`acme/api\`, \`acme/web\`, \`mkt-fyso\` (carpeta local).`);
  await repo("acme/web");
  assert.match(f.posts.at(-1)!, /^Este canal está atado a la carpeta local mkt-fyso/);
  await repo("borrar");
  assert.match(f.posts.at(-1)!, /^Este canal está atado a la carpeta local mkt-fyso/);
  assert.deepEqual(f.store.data.channels, {});
  assert.deepEqual(f.calls, []);
});

test("!repo in any other channel lists the directory as a local folder", async () => {
  const f = bound();
  await handleMention(f.deps, mention({ channel: "C1", command: "repo", text: "" }));
  assert.match(f.posts.at(-1)!, /Repos que conozco: `acme\/api`, `acme\/web`, `mkt-fyso` \(carpeta local\)\.$/);
});

test("a second request in the directory while one runs gets the busy reply and starts nothing", async () => {
  const f = bound();
  await handleMention(f.deps, mention());
  const before = [...f.calls];

  await handleMention(f.deps, mention({ threadTs: "400.1", ts: "400.1", text: "armá un calendario" }));

  assert.equal(f.posts.at(-1), `estoy con otro pedido en mkt-fyso (https://slack.test/${CH}/300.1); avisame cuando termine`);
  assert.deepEqual(f.calls, before, "no Orca call");
  assert.equal(f.store.data.jobs[`${CH}:400.1`], undefined);
});

test("two requests at once in the directory: the second one waits for the first even before it is stored", async () => {
  const f = bound();
  const first = handleMention(f.deps, mention());
  const second = handleMention(f.deps, mention({ threadTs: "400.1", ts: "400.1", text: "armá un calendario" }));
  await Promise.all([first, second]);

  assert.equal(f.calls.filter((c) => c.startsWith("followup")).length, 1);
  assert.ok(f.posts.includes(`estoy con otro pedido en mkt-fyso (https://slack.test/${CH}/300.1); avisame cuando termine`));
});

test("once the first run is done, a new request in the directory starts", async () => {
  const f = bound();
  await handleMention(f.deps, mention());
  await processBatch(f.deps, [done("m1", "d2")]);

  await handleMention(f.deps, mention({ threadTs: "400.1", ts: "400.1", text: "armá un calendario" }));

  assert.equal(f.calls.filter((c) => c.startsWith("followup")).length, 2);
  assert.equal(f.store.data.jobs[`${CH}:400.1`].state.kind, "working");
});

test("done in a directory posts listo en mkt-fyso with the report and the committed files, no PR button", async () => {
  const f = bound({
    async changedFiles(path, since) {
      return path === MKT && since === "base0" ? ["contenido/notas.md"] : ["wrong"];
    },
  });
  await handleMention(f.deps, mention());
  const id = `${CH}:300.1`;
  await mkdir(dirname(reportPath(id)), { recursive: true });
  writeFileSync(reportPath(id), "**Qué hice**\n\nCreé `contenido/notas.md` con 3 ideas.");
  try {
    await processBatch(f.deps, [done("m1", "d2")]);
  } finally {
    await rm(reportPath(id), { force: true });
  }

  const post = f.messages.at(-1)!;
  assert.equal(post.text, "✅ <@U1> listo en mkt-fyso.\n\n*Qué hice*\n\nCreé `contenido/notas.md` con 3 ideas.\n\n*Archivos commiteados:*\n• `contenido/notas.md`");
  assert.equal(post.blocks, undefined, "no PR button");
  assert.ok(!f.calls.includes("lookup"), "no PR lookup");
  assert.equal(f.store.data.jobs[id].state.kind, "done");
});

test("!revisa in a bound channel explains there are no PRs and starts no worker", async () => {
  const f = bound();
  await handleMention(f.deps, mention({ command: "revisa", text: "#12" }));
  assert.equal(f.posts.at(-1), "`!revisa` revisa PRs de GitHub, y mkt-fyso es una carpeta local sin PRs. Pedime el cambio directo, `!investiga` o `!plan`.");
  assert.deepEqual(f.calls, []);
});

test("!pregunta in a bound channel answers from the directory itself", async () => {
  const f = bound();
  await handleMention(f.deps, mention({ command: "pregunta", text: "¿qué hay en estrategia/?", target: github }));
  assert.deepEqual(f.calls, [`ask ${MKT} ¿qué hay en estrategia/?`]);
});

test("a follow-up in the same thread resumes its session in the same directory", async () => {
  const f = bound();
  f.sessions[MKT] = "sess-mkt";
  await handleMention(f.deps, mention());
  await processBatch(f.deps, [done("m1", "d2")]);

  await handleMention(f.deps, mention({ ts: "300.9", text: "sumá una cuarta idea" }));

  assert.ok(f.calls.includes(`terminal path:${MKT} claude --dangerously-skip-permissions --resume sess-mkt`));
  assert.equal(f.store.data.jobs[`${CH}:300.1`].state.kind, "working");
});

test("an owner's DM about a directory job waits while another thread works there", async () => {
  const f = bound();
  f.sessions[MKT] = "sess-mkt";
  await handleMention(f.deps, mention({ threadTs: "1791000300.000100", ts: "1791000300.000100" }));
  await processBatch(f.deps, [done("m1", "d2")]);
  await handleMention(f.deps, mention({ threadTs: "400.1", ts: "400.1", text: "armá un calendario" }));
  const before = [...f.calls];

  await handleDm(f.deps, { user: "U1", text: `<https://acme.slack.com/archives/${CH}/p1791000300000100> ¿qué ideas pusiste?`, channel: "D-U1", ts: "500.1" });

  assert.equal(f.dms.at(-1)!.text, `estoy con otro pedido en mkt-fyso (https://slack.test/${CH}/400.1); avisame cuando termine`);
  assert.deepEqual(f.calls, before);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
}

test("git helpers: an empty directory has no sha, then the files a run committed since its base", async () => {
  const dir = mkdtempSync(join(tmpdir(), "localdir-"));
  git(dir, "init", "-q");
  assert.equal(await headSha(dir), undefined);
  assert.deepEqual(await checkoutOf(dir), { branch: (await checkoutOf(dir)).branch, sha: undefined });
  writeFileSync(join(dir, "untracked.md"), "x");
  writeFileSync(join(dir, "a.md"), "a");
  git(dir, "add", "a.md");
  git(dir, "commit", "-q", "-m", "a");
  assert.deepEqual(await changedFiles(dir, undefined), ["a.md"], "no base: everything since the empty tree");
  const base = await headSha(dir);
  writeFileSync(join(dir, "b.md"), "b");
  git(dir, "add", "b.md");
  git(dir, "commit", "-q", "-m", "b");
  assert.deepEqual(await changedFiles(dir, base), ["b.md"]);
  assert.match((await checkoutOf(dir)).sha!, /^[0-9a-f]{7,}$/);
});
