import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import bolt from "@slack/bolt";
import { handleMention, handleThreadReply } from "../src/bot.ts";
import { inboxDir } from "../src/files.ts";
import { processBatch } from "../src/inbox.ts";
import { registerMessages } from "../src/slack.ts";
import { fakes, workingJob } from "./fakes.ts";

const png = (id: string, name = "captura.png") => ({ id, name, mimetype: "image/png", size: 3, url_private_download: `https://files.slack.com/${id}/download` });
const served = () => new Response("png", { headers: { "content-type": "image/png" } });

const target = { owner: "acme", name: "api", issue: { number: 5, url: "https://github.com/acme/api/issues/5" }, source: "link" as const };
const mention = { channel: "C1", threadTs: "100.1", ts: "100.1", user: "U1", text: "arreglalo", target };

function setup() {
  const f = fakes();
  for (const id of ["F1", "F2", "F3"]) f.slackFiles[`https://files.slack.com/${id}/download`] = served;
  return { f, inbox: inboxDir(f.deps.filesRoot, "C1:100.1") };
}

test("a thread reply with only a file while awaiting an answer replies once, naming the downloaded path", async () => {
  const { f, inbox } = setup();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;
  await processBatch(f.deps, [{ id: "m1", type: "question", body: "¿Cuál?", payload: JSON.stringify({ dispatchId: "d1", question: "¿Cuál?", options: ["A", "B"] }) }]);

  await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.5", user: "U1", text: "", files: [png("F1")] });

  const path = join(inbox, "F1-captura.png");
  assert.deepEqual(f.calls, [`reply m1 Files attached in Slack (inspect them with the Read tool):\n- ${path} (captura.png, image/png)`]);
  assert.equal(f.store.data.jobs[job.id].state.kind, "working");
  assert.match(f.updates.at(-1)!.text, /respondió: 📎 captura\.png/);
});

test("a thread reply with text and a file while working reaches the worker as guidance with the path", async () => {
  const { f, inbox } = setup();
  const job = workingJob();
  f.store.data.jobs[job.id] = job;

  await handleThreadReply(f.deps, { channel: "C1", threadTs: "100.1", ts: "100.5", user: "U1", text: "así se ve", files: [png("F1")] });

  assert.deepEqual(f.calls, [`send d1 así se ve\n\nFiles attached in Slack (inspect them with the Read tool):\n- ${join(inbox, "F1-captura.png")} (captura.png, image/png)`]);
  assert.deepEqual(f.reactions, ["100.5:eyes"]);
});

test("a new job downloads the thread's files into its inbox and lists them in the spec; skipped and failed ones are named in the thread", async () => {
  const { f, inbox } = setup();
  f.slackFiles["https://files.slack.com/F2/download"] = () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
  const files = [png("F1"), png("F2", "otra.png"), { id: "F9", name: "Doc de Google", mode: "external", url_private: "https://docs.google.com/x" }];

  await handleMention(f.deps, { ...mention, files });

  assert.equal(f.store.data.jobs["C1:100.1"].state.kind, "working", "missing files do not block the task");
  assert.match(f.specs[0], new RegExp(`- ${join(inbox, "F1-captura.png")} \\(captura\\.png, image/png\\)`));
  assert.doesNotMatch(f.specs[0], /otra\.png|Doc de Google/);
  const notice = f.posts.find((p) => p.startsWith("⚠️"))!;
  assert.match(notice, /Doc de Google: no es un archivo que Slack me deje bajar/);
  assert.match(notice, /otra\.png: .*files:read/);
});

test("a follow-up lists only the files the earlier run did not have", async () => {
  const { f, inbox } = setup();
  await handleMention(f.deps, { ...mention, files: [png("F1")] });
  await processBatch(f.deps, [{ id: "m4", type: "worker_done", body: "PR: https://github.com/acme/api/pull/1", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) }]);

  await handleMention(f.deps, { ...mention, ts: "100.9", text: "ahora con esta", files: [png("F2", "nueva.png"), png("F1")] });

  const followUp = f.specs.at(-1)!;
  assert.match(followUp, new RegExp(join(inbox, "F2-nueva.png")));
  assert.doesNotMatch(followUp, /F1-captura/);
  assert.deepEqual(f.fetched, ["https://files.slack.com/F1/download", "https://files.slack.com/F2/download"], "F1 is not fetched twice");
});

test("!pregunta passes the thread's files to the read-only answer", async () => {
  const { f, inbox } = setup();
  await handleMention(f.deps, { ...mention, ts: "100.8", text: "¿qué muestra?", command: "pregunta" as const, files: [png("F1")] });
  assert.deepEqual(f.calls, ["repo-path r1", `ask /repos/api ¿qué muestra? files=${join(inbox, "F1-captura.png")}`]);
});

function offlineApp() {
  return new bolt.App({ token: "xoxb-fake", appToken: "xapp-fake", socketMode: true, botId: "B1", botUserId: "UBOT", tokenVerificationEnabled: false, logLevel: bolt.LogLevel.ERROR });
}

function messageEvent(event: Record<string, unknown>) {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: `Ev${Math.random()}`,
    event_time: 1,
    event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "100.5", thread_ts: "100.1", event_ts: "100.5", ...event },
  };
}

/** The reply runs detached from processEvent and touches the disk, so wait on time rather than ticks. */
async function until(done: () => boolean): Promise<void> {
  for (const end = Date.now() + 5000; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
}

test("a file_share thread reply reaches the job; other message subtypes do not", async () => {
  const { f } = setup();
  f.store.data.jobs["C1:100.1"] = workingJob();
  const app = offlineApp();
  registerMessages(app, f.deps, "UBOT");
  const dispatch = (body: unknown) => app.processEvent({ body, ack: async () => {} } as Parameters<bolt.App["processEvent"]>[0]);

  await dispatch(messageEvent({ subtype: "channel_join", text: "<@U1> se unió" }));
  await dispatch(messageEvent({ subtype: "message_changed", text: "editado" }));
  await dispatch(messageEvent({ subtype: "file_share", text: "", files: [png("F1")] }));
  await until(() => f.calls.length > 0);
  await until(() => f.reactions.length > 0);

  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /^send d1 Files attached in Slack[\s\S]*F1-captura\.png/);
});
