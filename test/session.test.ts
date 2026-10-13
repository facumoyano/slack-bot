import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, newestSession } from "../src/session.ts";

test("a worktree path maps to Claude's projects dir with every non-alphanumeric char as a dash", () => {
  assert.equal(
    claudeProjectDir("/home/facu/orca/workspaces/slack-bot/proto-resume", "/home/facu"),
    "/home/facu/.claude/projects/-home-facu-orca-workspaces-slack-bot-proto-resume",
  );
  assert.equal(claudeProjectDir("/w/my_repo.v2", "/h"), "/h/.claude/projects/-w-my-repo-v2");
});

test("the newest .jsonl wins; subdirectories, other files and unsafe names are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-"));
  const at = async (name: string, seconds: number) => {
    await writeFile(join(dir, name), "{}");
    await utimes(join(dir, name), seconds, seconds);
  };
  await at("aaaa-old.jsonl", 1000);
  await at("bbbb-new.jsonl", 2000);
  await at("notes.txt", 9000);
  await at("x;rm -rf.jsonl", 9000);
  await mkdir(join(dir, "cccc-dir.jsonl"));

  assert.equal(await newestSession(dir), "bbbb-new");
});

test("a missing projects dir has no session", async () => {
  assert.equal(await newestSession(join(tmpdir(), "does-not-exist-42")), undefined);
});

test("with a marker, a newer session that does not name the job (someone's own Claude in the same directory) is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-"));
  const at = async (name: string, body: string, seconds: number) => {
    await writeFile(join(dir, name), body);
    await utimes(join(dir, name), seconds, seconds);
  };
  await at("aaaa-worker.jsonl", '{"message":"report to data/reports/C1-17-00.md"}', 1000);
  await at("bbbb-human.jsonl", '{"message":"armá el post de mañana"}', 2000);

  assert.equal(await newestSession(dir, "C1-17-00"), "aaaa-worker");
  assert.equal(await newestSession(dir), "bbbb-human");
});
