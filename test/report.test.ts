import { test } from "node:test";
import assert from "node:assert/strict";
import { toSlackMrkdwn } from "../src/report.ts";
import { applyInboxMessage } from "../src/jobs.ts";

test("agent Markdown renders as Slack mrkdwn and keeps paragraphs", () => {
  const md = [
    "## Qué pasaba",
    "**Causa:** `chat.stopStream` no cerraba el plan. Ver [la doc](https://api.slack.com/x).",
    "",
    "",
    "",
    "**Qué cambié**",
    "- cierre con plan_update",
    "  * heartbeat en runtime state",
    "```",
    "- **literal**",
    "```",
  ].join("\n");
  assert.equal(
    toSlackMrkdwn(md),
    [
      "*Qué pasaba*",
      "*Causa:* `chat.stopStream` no cerraba el plan. Ver <https://api.slack.com/x|la doc>.",
      "",
      "*Qué cambié*",
      "• cierre con plan_update",
      "  • heartbeat en runtime state",
      "```",
      "- **literal**",
      "```",
    ].join("\n"),
  );
});

test("worker_done posts the report with blank lines between head, body and PR", () => {
  const job = {
    id: "C1:1.2",
    slack: { channel: "C1", threadTs: "1.2", requester: "U1" },
    repo: { owner: "o", name: "r", orcaRepoId: "id" },
    request: "x",
    dispatchId: "d1",
    state: { kind: "working" as const },
  };
  const store = { jobs: { [job.id]: job }, processedMsgIds: [] };
  const msg = { id: "m1", type: "worker_done", body: "hecho\nPR: https://github.com/o/r/pull/9", payload: JSON.stringify({ dispatchId: "d1", outcome: "succeeded" }) };
  const out = applyInboxMessage(store, msg, undefined, "*Qué pasaba*\nalgo\n\n*Qué cambié*\n• cosa");
  assert.equal(out?.post, "✅ <@U1> terminé.\n\n*Qué pasaba*\nalgo\n\n*Qué cambié*\n• cosa\n\n*PR:* https://github.com/o/r/pull/9");
});
