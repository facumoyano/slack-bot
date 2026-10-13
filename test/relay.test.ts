import { test } from "node:test";
import assert from "node:assert/strict";
import { instructionOf, mentionedUsers, parseRelayFile, parseThreadLink } from "../src/relay.ts";

const ROOT = "https://acme.slack.com/archives/C0ABC123/p1791548002024869";

test("a plain permalink names its message as the thread", () => {
  assert.deepEqual(parseThreadLink(`${ROOT} preguntale a @salva`), { channel: "C0ABC123", threadTs: "1791548002.024869", url: ROOT });
});

test("Slack's <url> and <url|label> wrappers are unwrapped, and the instruction drops the link", () => {
  for (const text of [`<${ROOT}> avisale a @sebas`, `<${ROOT}|hilo> avisale a @sebas`]) {
    const link = parseThreadLink(text)!;
    assert.equal(link.threadTs, "1791548002.024869");
    assert.equal(instructionOf(text, link), "avisale a @sebas");
  }
});

test("a reply's link names the thread through thread_ts, even with Slack's &amp; escaping", () => {
  const reply = "https://acme.slack.com/archives/C0ABC123/p1791548099000100?thread_ts=1791548002.024869&amp;cid=C0ABC123";
  const link = parseThreadLink(`mirá <${reply}> y preguntale`)!;
  assert.equal(link.channel, "C0ABC123");
  assert.equal(link.threadTs, "1791548002.024869");
  assert.equal(instructionOf(`mirá <${reply}> y preguntale`, link), "mirá y preguntale");
});

test("a text without a message permalink has no link", () => {
  assert.equal(parseThreadLink("preguntale a @salva por qué"), undefined);
  assert.equal(parseThreadLink("https://github.com/acme/api/pull/4"), undefined);
});

test("named people are Slack tokens and typed @names, each once, never an email", () => {
  assert.deepEqual(mentionedUsers("preguntale a <@U0SALVA01> y a @sebas.r. y otra vez @sebas.r, no a juan@acme.com"), ["U0SALVA01", "sebas.r"]);
  assert.deepEqual(mentionedUsers("<@U0SALVA01|salva> mirá"), ["U0SALVA01"]);
});

const rules = { people: ["U0SALVA01"], unknown: [{ name: "zoe", why: 'no encontré a "zoe" en Slack' }], owner: "U0OWNER01" };

test("the thread file is a header naming whose reply it awaits and the exact message", () => {
  assert.deepEqual(parseRelayFile("await: <@U0SALVA01>\n\n<@U0SALVA01> ¿te parece bien?\n- `src/a.ts:3`", rules), {
    kind: "thread",
    text: "<@U0SALVA01> ¿te parece bien?\n- `src/a.ts:3`",
    awaiting: ["U0SALVA01"],
  });
  assert.deepEqual(parseRelayFile("await: none\n\n<@U0SALVA01> el PR está listo.", rules), { kind: "thread", text: "<@U0SALVA01> el PR está listo.", awaiting: [] });
});

test("a private header carries an answer only the owner reads", () => {
  assert.deepEqual(parseRelayFile("private\n\nElegí `agents` porque:\n- `src/perms.ts:12` los lee juntos", rules), {
    kind: "private",
    text: "Elegí `agents` porque:\n- `src/perms.ts:12` los lee juntos",
  });
  assert.deepEqual(parseRelayFile("Private\n\nSalva y zoe opinan distinto; si me lo pedís, le escribo a <@U0OTHER01>.", rules), {
    kind: "private",
    text: "Salva y zoe opinan distinto; si me lo pedís, le escribo a <@U0OTHER01>.",
  }, "a private answer may name anyone: nobody else reads it");
  assert.deepEqual(parseRelayFile("private\n\n  \n", rules), { error: "la respuesta privada está vacía" });
});

test("a malformed thread file is an error, never a message", () => {
  assert.ok("error" in parseRelayFile("<@U0SALVA01> hola", rules), "no header");
  assert.ok("error" in parseRelayFile("await: none\n\n   ", rules), "empty message");
  assert.ok("error" in parseRelayFile("await: <@U0OTHER01>\n\nhola", rules), "awaits someone the owner did not name");
  assert.ok("error" in parseRelayFile("await: none\n\n<@U0OTHER01> el PR está listo", rules), "mentions someone the owner did not name");
  assert.ok("error" in parseRelayFile("await: quién sabe\n\nhola", rules), "unreadable header");
  assert.deepEqual(parseRelayFile("await: none\n\n<@U0OWNER01> me pidió que te avise", rules), { error: "el mensaje te menciona" });
});

test("a thread message for a name that matched nobody in Slack is refused with the reason", () => {
  assert.deepEqual(parseRelayFile("await: @zoe\n\n@zoe ¿te parece bien?", rules), { error: 'no encontré a "zoe" en Slack' });
  assert.deepEqual(parseRelayFile("await: none\n\n@Zoe el PR está listo.", rules), { error: 'no encontré a "zoe" en Slack' });
});
