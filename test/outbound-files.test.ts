import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { outboxDir } from "../src/files.ts";
import { processBatch } from "../src/inbox.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { fakes, workingJob } from "./fakes.ts";

const status = (id: string): InboxMessage => ({ id, type: "status", body: "tests pasando", payload: JSON.stringify({ dispatchId: "d1" }) });
const done: InboxMessage = { id: "m9", type: "worker_done", body: "Listo\nPR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) };

async function withOutbox(files: Record<string, string>) {
  const f = fakes();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;
  const out = outboxDir(f.deps.filesRoot, job.id);
  await mkdir(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(out, name), body);
  return { f, out };
}

test("new outbox files upload before the message's text, move to sent/, and a replayed or later message uploads nothing again", async () => {
  const { f, out } = await withOutbox({ "antes.png": "a", "despues.png": "b", ".env": "SECRET=1" });
  const order: string[] = [];
  const poster = f.deps.poster;
  f.deps.poster = {
    ...poster,
    uploadFile: async (job, path) => (order.push(`upload ${path}`), poster.uploadFile(job, path)),
    postToThread: async (job, text, blocks) => (order.push(`post ${text}`), poster.postToThread(job, text, blocks)),
  };

  await processBatch(f.deps, [status("m1")]);
  await processBatch(f.deps, [status("m1"), done]);

  assert.deepEqual(order.slice(0, 3), [`upload ${join(out, "antes.png")}`, `upload ${join(out, "despues.png")}`, "post ⏳ tests pasando"]);
  assert.deepEqual(f.uploads, [join(out, "antes.png"), join(out, "despues.png")], "uploaded once each, dotfile never");
  assert.deepEqual((await readdir(out)).sort(), [".env", "sent"]);
  assert.deepEqual((await readdir(join(out, "sent"))).sort(), ["antes.png", "despues.png"]);
  assert.match(f.posts.at(-1)!, /✅ <@U1> terminé/);
});

test("a failed upload is said in the thread, the text still posts, and the file stays for the next message", async () => {
  const { f, out } = await withOutbox({ "video.mp4": "v", "log.txt": "l" });
  f.failUploads.add(join(out, "video.mp4"));

  await processBatch(f.deps, [done]);

  assert.deepEqual(f.posts.map((p) => p.split("\n")[0]), ["⚠️ no pude subir video.mp4: upload_failed", "✅ <@U1> terminé."]);
  assert.deepEqual(f.uploads, [join(out, "log.txt")]);
  assert.deepEqual((await readdir(out)).sort(), ["sent", "video.mp4"]);
  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "done");
});
