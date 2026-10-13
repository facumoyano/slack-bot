import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelaySpec, buildSpec } from "../src/spec.ts";
import type { Mode } from "../src/jobs.ts";

const MKT = "/home/facu/orca/projects/mkt-fyso";
const job = (mode: Mode) => ({
  repo: { kind: "dir" as const, name: "mkt-fyso", path: MKT, orcaRepoId: "rdir" },
  slack: { channel: "CMKT0001", threadTs: "1.2", requester: "U1" },
  mode,
  request: "creá un archivo notas.md con 3 ideas de posts",
});
const paths = { reportPath: "/tmp/r.md", planPath: "/tmp/r.plan.md", outbox: "/tmp/out" };
const PUBLISHING = /\bgh\b|\bPR\b|pull request|push|github|origin|branch to|new branch/i;

test("a change in a local directory ends at a local commit of the touched paths, with nothing about publishing", () => {
  const spec = buildSpec({ job: job("change"), ...paths });
  assert.doesNotMatch(spec, PUBLISHING);
  assert.match(spec, new RegExp(`local working directory \`${MKT}\``));
  assert.match(spec, /read its `CLAUDE\.md` and `AGENTS\.md`/);
  assert.match(spec, /commit locally only the paths you created or changed, naming each one: `git add <path> <path> …`/);
  assert.match(spec, /Never `git add -A`, `git add \.` or `git commit -a`/);
  assert.match(spec, /Never commit `\.mcp\.json`, `\.claude\/`, `\.agents\/` or any secret/);
  assert.match(spec, /Do not delete, move or rename files you did not create/);
  assert.match(spec, /Do not create or switch branches; never `git clean`, `git reset`, `git stash`, `git checkout -- …` or `git restore`/);
  assert.match(spec, /\*\*Archivos\*\* \(each path you created or changed\)/);
  assert.match(spec, /\/tmp\/out/);
  assert.match(spec, /creá un archivo notas\.md/);
  assert.ok(spec.indexOf("pstack:poteto-mode") < spec.indexOf("## Target"), "poteto-mode is invoked before the task");
});

test("an investigation in a local directory changes and commits nothing", () => {
  const spec = buildSpec({ job: job("investigate"), ...paths });
  assert.doesNotMatch(spec, PUBLISHING);
  assert.match(spec, /Investigation playbook/);
  assert.match(spec, /Do not commit, switch branches, or change, delete or move any file/);
  assert.doesNotMatch(spec, /git add/);
});

test("a plan in a local directory waits for approval before the first edit and ends at the local commit", () => {
  const spec = buildSpec({ job: job("plan"), ...paths });
  assert.doesNotMatch(spec, PUBLISHING);
  assert.match(spec, /--options "Aprobar,Cambiar"/);
  assert.match(spec, /carry out the plan and finish with the local commit/);
  assert.match(spec, /git add <path>/);
});

test("a resumed run in a local directory continues the same session under the same rules", () => {
  const spec = buildSpec({ job: job("change"), resumed: true, ...paths });
  assert.doesNotMatch(spec, PUBLISHING);
  assert.match(spec, /continuing your own previous work in this directory/);
});

test("a relay on a local-directory job names the directory and forbids discarding its untracked files", () => {
  const spec = buildRelaySpec({
    job: job("change"),
    relay: { owner: "U1", dmThread: "1.1", instruction: "¿qué hiciste?", people: [], unknown: [], link: "https://slack.test/x" },
    step: { kind: "write" },
    relayPath: "/tmp/r.relay.md",
  });
  assert.match(spec, new RegExp(`local directory \`${MKT}\` \\(mkt-fyso\\)`));
  assert.match(spec, /never `git clean`/);
});
