import { test } from "node:test";
import assert from "node:assert/strict";
import { commandMode, helpText, parseCommand, parseRepoArg } from "../src/commands.ts";

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

test("!investiga and !plan parse with their aliases and pick their run's mode; other commands and plain text are changes", () => {
  const cases: [string, string, string][] = [
    ["!investiga ¿por qué el webhook responde 500?", "investiga", "investigate"],
    ["!investigá por qué falla", "investiga", "investigate"],
    ["!investigate why it fails", "investiga", "investigate"],
    ["!plan arreglá el issue 1717", "plan", "plan"],
    ["!planear arreglá el issue 1717", "plan", "plan"],
    ["!nuevo arreglá el login", "nuevo", "change"],
    ["!revisa https://github.com/acme/api/pull/7 mirá los tests", "revisa", "review"],
    ["!revisá #7", "revisa", "review"],
    ["!review acme/api#7", "revisa", "review"],
    ["!revisar #7", "revisa", "review"],
  ];
  for (const [text, name, mode] of cases) {
    const command = parseCommand(text);
    assert.equal(command?.name, name, text);
    assert.equal(commandMode(command?.name), mode, text);
  }
  assert.deepEqual(parseCommand("!investiga ¿por qué?"), { name: "investiga", rest: "¿por qué?" });
  assert.deepEqual(parseCommand("!revisa #7 fijate los errores"), { name: "revisa", rest: "#7 fijate los errores" });
  assert.equal(commandMode(parseCommand("arreglá el login")?.name), "change");
  assert.equal(parseCommand("!planes para hoy"), undefined);
});

test("help lists !investiga and !plan, and tells !pregunta apart from !investiga", () => {
  const help = helpText();
  assert.match(help, /`!investiga <pregunta>` \(`!investigate`\): .*reporte.*sin PR/);
  assert.match(help, /`!plan <pedido>` \(`!planear`\): .*antes de tocar código/);
  assert.match(help, /`!pregunta <pregunta>` \(`!ask`\): respuesta rápida.*`!investiga`/);
});
