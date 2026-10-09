import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMention } from "../src/bot.ts";
import { openStore } from "../src/store.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakes } from "./fakes.ts";

const at = { channel: "C1", threadTs: "300.1", ts: "300.1", user: "U1", command: "repo" as const };

test("!repo sets, shows and clears the channel default", async () => {
  const f = fakes();

  await handleMention(f.deps, { ...at, text: "web" });
  assert.deepEqual(f.store.data.channels, { C1: { owner: "acme", name: "web" } });
  assert.equal(f.posts.at(-1), "📌 repo de este canal: acme/web");

  await handleMention(f.deps, { ...at, text: "" });
  assert.match(f.posts.at(-1)!, /^📌 repo de este canal: acme\/web\nRepos que conozco: `acme\/api`, `acme\/web`\.$/);

  await handleMention(f.deps, { ...at, text: "borrar" });
  assert.deepEqual(f.store.data.channels, {});
  await handleMention(f.deps, { ...at, text: "" });
  assert.match(f.posts.at(-1)!, /^Este canal no tiene repo por defecto\./);
  assert.deepEqual(f.calls, [], "no worker is touched");
});

test("!repo with an unknown repo keeps the default and lists the known repos", async () => {
  const f = fakes();
  f.store.data.channels.C1 = { owner: "acme", name: "api" };

  await handleMention(f.deps, { ...at, text: "backend" });

  assert.deepEqual(f.store.data.channels, { C1: { owner: "acme", name: "api" } });
  assert.match(f.posts.at(-1)!, /No reconozco `backend`.*\nRepos que conozco: `acme\/api`, `acme\/web`\./s);
});

test("a store saved before channel defaults existed opens with none", () => {
  const path = join(mkdtempSync(join(tmpdir(), "store-")), "state.json");
  writeFileSync(path, JSON.stringify({ jobs: {}, processedMsgIds: [] }));
  assert.deepEqual(openStore(path).data.channels, {});
});
