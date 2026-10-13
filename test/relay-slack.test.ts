import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import bolt from "@slack/bolt";
import { processBatch } from "../src/inbox.ts";
import { newJob, transition } from "../src/jobs.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { relayPath } from "../src/report.ts";
import { registerMessages } from "../src/slack.ts";
import { fakes } from "./fakes.ts";

const CHANNEL = "CRELAYB";
const THREAD = "1791548002.024869";
const ID = `${CHANNEL}:${THREAD}`;
const LINK = `https://acme.slack.com/archives/${CHANNEL}/p1791548002024869`;
const RESUME = ["terminal path:/wt/api claude --dangerously-skip-permissions --resume sess-1", "wait term-1", "resume term-1"];
const ASK = "await: <@U0SALVA01>\n\n<@U0SALVA01> ¿te parece bien?";

function setup() {
  const f = fakes();
  const job = newJob({ slack: { channel: CHANNEL, threadTs: THREAD, requester: "U1" }, repo: { owner: "acme", name: "api", orcaRepoId: "r1" }, request: "x", mode: "change" });
  const working = transition(job, { kind: "started", worktreeId: "r1::/wt/api", taskId: "t1", dispatchId: "d1" })!;
  f.deps.store.data.jobs[ID] = transition(working, { kind: "worker_done", outcome: "succeeded", summary: "ok", sessionId: "sess-1" })!;
  return f;
}

const done = (id: string): InboxMessage => ({ id, type: "worker_done", body: "listo", payload: JSON.stringify({ dispatchId: "d3", outcome: "succeeded" }) });

async function workerWrites(text: string): Promise<void> {
  await mkdir(dirname(relayPath(ID)), { recursive: true });
  await writeFile(relayPath(ID), text);
}

test("from Slack: a DM event reaches the relay, and a stranger's thread reply reaches the wait", async () => {
  const f = setup();
  const app = new bolt.App({ token: "xoxb-fake", appToken: "xapp-fake", socketMode: true, botId: "B1", botUserId: "UBOT", tokenVerificationEnabled: false, logLevel: bolt.LogLevel.ERROR });
  registerMessages(app, f.deps, "UBOT");
  const dispatch = (event: Record<string, unknown>) =>
    app.processEvent({ body: { type: "event_callback", team_id: "T", api_app_id: "A1", event_id: `Ev${Math.random()}`, event_time: 1, event: { type: "message", ...event } }, ack: async () => {} } as Parameters<bolt.App["processEvent"]>[0]);
  const settle = async (done: () => boolean) => {
    for (const end = Date.now() + 2000; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  };

  await dispatch({ channel: "D0OWNER", channel_type: "im", user: "U1", text: `<${LINK}> preguntale a <@U0SALVA01>`, ts: "1.1" });
  await settle(() => f.calls.length >= 3);
  assert.deepEqual(f.calls, RESUME);
  await workerWrites(ASK);
  await processBatch(f.deps, [done("w-ask")]);

  await dispatch({ channel: CHANNEL, channel_type: "channel", user: "U0SALVA01", text: "me parece bien", ts: "900.5", thread_ts: THREAD });
  await settle(() => f.calls.length >= 7);
  assert.match(f.specs.at(-1)!, /me parece bien/);
  assert.equal(f.posts.length, 1);
});
