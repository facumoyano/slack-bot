import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDirs, parseDirs } from "../src/dirs.ts";

const MKT = "/home/facu/orca/projects/mkt-fyso";
const checks = (dirs: string[], repos: Record<string, string>) => ({
  isDirectory: async (path: string) => dirs.includes(path),
  orcaRepoAt: async (path: string) => (repos[path] ? { id: `id-${repos[path]}`, name: repos[path] } : undefined),
});

test("a good entry binds the channel to the directory, named as Orca names it", async () => {
  const loaded = await loadDirs(` C0123ABC=${MKT}/ `, checks([MKT], { [MKT]: "mkt-fyso" }));
  assert.deepEqual(loaded, { dirs: { C0123ABC: { name: "mkt-fyso", path: MKT } }, problems: [] });
});

test("an empty or unset value binds nothing", async () => {
  assert.deepEqual(await loadDirs(undefined, checks([], {})), { dirs: {}, problems: [] });
  assert.deepEqual(parseDirs(" , "), { entries: [], problems: [] });
});

test("a missing folder is skipped and reported; the good entries still load", async () => {
  const loaded = await loadDirs(`C0123ABC=${MKT},C0999XYZ=/nope`, checks([MKT], { [MKT]: "mkt-fyso", "/nope": "nope" }));
  assert.deepEqual(Object.keys(loaded.dirs), ["C0123ABC"]);
  assert.deepEqual(loaded.problems, ["C0999XYZ: /nope does not exist or is not a directory"]);
});

test("a folder Orca does not know is skipped with the command that adds it", async () => {
  const loaded = await loadDirs(`C0123ABC=${MKT}`, checks([MKT], {}));
  assert.deepEqual(loaded.dirs, {});
  assert.deepEqual(loaded.problems, [`C0123ABC: ${MKT} is not an Orca repo (orca repo add --path ${MKT})`]);
});

test("malformed entries are reported, not thrown", () => {
  const { entries, problems } = parseDirs(`mkt-fysobiz=${MKT},C0123ABC,C0123ABC=relative/path,C0444DEF=${MKT},C0444DEF=/other`);
  assert.deepEqual(entries, [{ channel: "C0444DEF", path: MKT }]);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^"mkt-fysobiz=.*" is not channelId=\/path/);
  assert.match(problems[1], /^"C0123ABC" is not channelId=\/path/);
  assert.equal(problems[2], 'C0123ABC: "relative/path" is not an absolute path');
  assert.equal(problems[3], "C0444DEF is listed more than once");
});
