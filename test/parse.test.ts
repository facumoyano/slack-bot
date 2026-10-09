import { test } from "node:test";
import assert from "node:assert/strict";
import { findTarget, messageTexts, newTaskRequest, parseTarget, stripMention, matchKnownRepo } from "../src/parse.ts";

test("issue URL wrapped as a Slack link", () => {
  assert.deepEqual(parseTarget(["mirá <https://github.com/acme/web-app/issues/42|acme/web-app#42 Login roto>"]), {
    owner: "acme",
    name: "web-app",
    issue: { number: 42, url: "https://github.com/acme/web-app/issues/42" },
  });
});

test("pull URL keeps the pull path", () => {
  assert.deepEqual(parseTarget(["https://github.com/acme/api/pull/7"])?.issue, {
    number: 7,
    url: "https://github.com/acme/api/pull/7",
  });
});

test("short owner/repo#n reference", () => {
  assert.deepEqual(parseTarget(["arreglá acme/api#13 porfa"]), {
    owner: "acme",
    name: "api",
    issue: { number: 13, url: "https://github.com/acme/api/issues/13" },
  });
});

test("bare repo URL has no issue and drops .git", () => {
  assert.deepEqual(parseTarget(["clonalo de https://github.com/acme/tool.git."]), { owner: "acme", name: "tool" });
});

test("mention text wins over thread root", () => {
  const target = parseTarget(["usá acme/other#1", "https://github.com/acme/api/issues/9"]);
  assert.equal(target?.name, "other");
});

test("falls back to the root when the mention names nothing", () => {
  const target = parseTarget(["arreglalo", "https://github.com/acme/api/issues/9"]);
  assert.equal(target?.issue?.number, 9);
});

test("no target", () => {
  assert.equal(parseTarget(["hola", "nada por acá"]), undefined);
});

test("finds links hidden in unfurled attachments and blocks", () => {
  const texts = messageTexts({
    text: "nuevo issue",
    attachments: [{ title: "Login roto", title_link: "https://github.com/acme/web/issues/3" }],
  });
  assert.equal(parseTarget(texts)?.issue?.number, 3);

  const fromBlocks = messageTexts({
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://github.com/acme/web/issues/5" }] }] }],
  });
  assert.equal(parseTarget(fromBlocks)?.issue?.number, 5);
});

test("stripMention removes only the bot mention", () => {
  assert.equal(stripMention("<@UBOT> arreglá esto <@U123>", "UBOT"), "arreglá esto <@U123>");
});

test("bare repo names resolve against known repos, treating - and _ alike", () => {
  const repos = [
    { owner: "fyso-dev", name: "fyso_backend", displayName: "fyso-backend" },
    { owner: "fyso-dev", name: "opensource-ingest" },
  ];
  assert.deepEqual(matchKnownRepo(["es el repo de fyso-backend"], repos), { owner: "fyso-dev", name: "fyso_backend" });
  assert.deepEqual(matchKnownRepo(["mirá fyso_backend"], repos), { owner: "fyso-dev", name: "fyso_backend" });
  assert.equal(matchKnownRepo(["el backend de fyso"], repos), undefined);
});

test("a link later in the thread is found when the mention has none", () => {
  const thread = ["es el repo de fyso-backend", "es el repo `fyso-dev/fyso_backend` y la issue es la #1717: <https://github.com/fyso-dev/fyso_backend/issues/1717>"];
  assert.deepEqual(parseTarget(thread)?.issue, { number: 1717, url: "https://github.com/fyso-dev/fyso_backend/issues/1717" });
});

test("nuevo, nueva and !new mark a separate task and are stripped from the request", () => {
  assert.equal(newTaskRequest("nuevo arreglá el login en acme/api"), "arreglá el login en acme/api");
  assert.equal(newTaskRequest("  Nueva: sumá tests"), "sumá tests");
  assert.equal(newTaskRequest("!NEW fix the build"), "fix the build");
  assert.equal(newTaskRequest("nuevo"), "");
});

test("words that only start with the keyword, or mention it later, are not a separate task", () => {
  assert.equal(newTaskRequest("nuevos tests para el login"), undefined);
  assert.equal(newTaskRequest("novedades: nuevo endpoint"), undefined);
  assert.equal(newTaskRequest("!newer"), undefined);
  assert.equal(newTaskRequest("agregá un test nuevo"), undefined);
});

test("findTarget says whether a link or a known repo name found the target", () => {
  const repos = [{ owner: "acme", name: "billing" }];
  assert.equal(findTarget(["mirá acme/api#3"], repos)?.source, "link");
  assert.deepEqual(findTarget(["tocá billing"], repos), { owner: "acme", name: "billing", source: "name" });
  assert.equal(findTarget(["tocá el backend"], repos), undefined);
});
