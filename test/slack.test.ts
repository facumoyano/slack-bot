import { test } from "node:test";
import assert from "node:assert/strict";
import bolt from "@slack/bolt";
import { ACTIONS } from "../src/blocks.ts";
import { registerActions } from "../src/slack.ts";
import { fakes } from "./fakes.ts";

function offlineApp() {
  return new bolt.App({
    token: "xoxb-fake",
    appToken: "xapp-fake",
    socketMode: true,
    botId: "B1",
    botUserId: "UBOT",
    tokenVerificationEnabled: false,
    logLevel: bolt.LogLevel.ERROR,
  });
}

function blockAction(action: Record<string, unknown>, user = "U9") {
  return {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: user },
    api_app_id: "A1",
    token: "t",
    trigger_id: "tr",
    channel: { id: "C1" },
    container: { type: "message", message_ts: "900.1", channel_id: "C1" },
    message: { type: "message", ts: "900.1", thread_ts: "100.1", text: "x" },
    actions: [{ block_id: "b", action_ts: "1", ...action }],
  };
}

async function dispatch(app: bolt.App, body: unknown): Promise<number> {
  let acks = 0;
  await app.processEvent({ body, ack: async () => void acks++ } as Parameters<bolt.App["processEvent"]>[0]);
  return acks;
}

/** Click handling runs after the ack, detached from processEvent. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setImmediate(r));
}

test("Bolt acks every click, URL buttons included, and routes parsed ones to the click handler", async () => {
  const f = fakes();
  const app = offlineApp();
  registerActions(app, f.deps, async () => []);

  const stopAcks = await dispatch(app, blockAction({ type: "button", action_id: ACTIONS.stop, value: "C1:100.1", text: { type: "plain_text", text: "Parar" } }));
  const prAcks = await dispatch(app, blockAction({ type: "button", action_id: ACTIONS.pr, url: "https://github.com/a/b/pull/1", text: { type: "plain_text", text: "Ver PR" } }));
  await until(() => f.ephemerals.length > 0);

  assert.equal(stopAcks, 1);
  assert.equal(prAcks, 1);
  assert.deepEqual(f.ephemerals, ["U9: Perdón <@U9>, no tengo permiso para trabajar para vos. Pedile al dueño del bot que agregue tu ID `U9` a ALLOWED_SLACK_USERS."]);
  assert.deepEqual(f.calls, []);
});

test("a static_select click is read from its selected option", async () => {
  const f = fakes();
  const app = offlineApp();
  registerActions(app, f.deps, async () => []);

  await dispatch(
    app,
    blockAction(
      { type: "static_select", action_id: ACTIONS.repo, selected_option: { text: { type: "plain_text", text: "acme/web" }, value: JSON.stringify({ j: "C1:100.1", r: "acme/web" }) } },
      "U1",
    ),
  );
  await until(() => f.ephemerals.length > 0);

  assert.deepEqual(f.ephemerals, ["U1: Ese botón ya no es válido: el hilo siguió de largo."], "parsed and judged stale: no job in that thread");
});
