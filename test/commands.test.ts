import { test } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand, parseRepoArg } from "../src/commands.ts";

test("every command and alias parses, with the rest of the text as its argument", () => {
  const cases: [string, string][] = [
    ["!nuevo arreglá el login en acme/api", "nuevo"],
    ["!new fix the build", "nuevo"],
    ["!pregunta ¿dónde se valida el token?", "pregunta"],
    ["!ask where is the token checked?", "pregunta"],
    ["!parar", "parar"],
    ["!cancelar", "parar"],
    ["!stop", "parar"],
    ["!aparte esto es entre nosotros", "aparte"],
    ["!aside between us", "aparte"],
    ["!ayuda", "ayuda"],
    ["!help", "ayuda"],
    ["!repo fyso-backend", "repo"],
  ];
  for (const [text, name] of cases) assert.equal(parseCommand(text)?.name, name, text);
  assert.deepEqual(parseCommand("  !nuevo: sumá tests"), { name: "nuevo", rest: "sumá tests" });
  assert.deepEqual(parseCommand("!pregunta"), { name: "pregunta", rest: "" });
});

test("case and accents are ignored", () => {
  assert.equal(parseCommand("!PREGUNTA qué hace esto")?.name, "pregunta");
  assert.equal(parseCommand("!cancelár")?.name, "parar");
  assert.equal(parseCommand("!Ápárte ok")?.name, "aparte");
});

test("plain words, prefixes, unknown commands and later commands are text", () => {
  for (const text of [
    "pará",
    "parar",
    "nuevo arreglá el login",
    "nuevos tests para el login",
    "pregunta: ¿dónde está?",
    "!paramos",
    "!newer",
    "!nuevo, sumá tests",
    "!xyz hola",
    "por favor !parar",
    "arreglalo y después !nuevo otra cosa",
    "",
  ]) {
    assert.equal(parseCommand(text), undefined, text);
  }
});

test("the help lists every command once", () => {
  const help = helpText();
  for (const usage of ["!nuevo", "!pregunta", "!repo", "!parar", "!aparte", "!ayuda"]) assert.ok(help.includes(`\`${usage}`), usage);
  assert.ok(help.includes("`!cancelar`"));
});

const repos = [
  { owner: "fyso-dev", name: "fyso_backend", displayName: "fyso-backend" },
  { owner: "acme", name: "api" },
];

test("!repo sets a repo from a known name, owner/name or a GitHub link", () => {
  assert.deepEqual(parseRepoArg("fyso-backend", repos), { kind: "set", repo: { owner: "fyso-dev", name: "fyso_backend" } });
  assert.deepEqual(parseRepoArg("api", repos), { kind: "set", repo: { owner: "acme", name: "api" } });
  assert.deepEqual(parseRepoArg("ACME/Api", repos), { kind: "set", repo: { owner: "acme", name: "api" } });
  assert.deepEqual(parseRepoArg("other/thing", repos), { kind: "set", repo: { owner: "other", name: "thing" } });
  assert.deepEqual(parseRepoArg("<https://github.com/acme/api/issues/4>", repos), { kind: "set", repo: { owner: "acme", name: "api" } });
  assert.deepEqual(parseRepoArg("https://github.com/org/repo.git", repos), { kind: "set", repo: { owner: "org", name: "repo" } });
});

test("!repo with no argument shows, borrar and clear remove, anything else is unknown", () => {
  assert.deepEqual(parseRepoArg("  ", repos), { kind: "show" });
  assert.deepEqual(parseRepoArg("borrar", repos), { kind: "clear" });
  assert.deepEqual(parseRepoArg("Clear", repos), { kind: "clear" });
  assert.deepEqual(parseRepoArg("backend", repos), { kind: "unknown", text: "backend" });
  assert.deepEqual(parseRepoArg("src/parse.ts y algo", repos), { kind: "unknown", text: "src/parse.ts y algo" });
});
