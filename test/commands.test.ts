import { test } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand } from "../src/commands.ts";

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
  for (const usage of ["!nuevo", "!pregunta", "!parar", "!aparte", "!ayuda"]) assert.ok(help.includes(`\`${usage}`), usage);
  assert.ok(help.includes("`!cancelar`"));
});
