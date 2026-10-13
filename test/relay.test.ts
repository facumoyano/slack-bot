import { test } from "node:test";
import assert from "node:assert/strict";
import { instructionOf, mentionedUsers, parseRelayMessage, parseThreadLink } from "../src/relay.ts";

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

const people = { people: ["U0SALVA01"], owner: "U0OWNER01" };

test("the thread file is a header naming whose reply it awaits and the exact message", () => {
  assert.deepEqual(parseRelayMessage("await: <@U0SALVA01>\n\n<@U0SALVA01> ¿te parece bien?\n- `src/a.ts:3`", people), {
    text: "<@U0SALVA01> ¿te parece bien?\n- `src/a.ts:3`",
    awaiting: ["U0SALVA01"],
  });
  assert.deepEqual(parseRelayMessage("await: none\n\n<@U0SALVA01> el PR está listo.", people), { text: "<@U0SALVA01> el PR está listo.", awaiting: [] });
});

test("a malformed thread file is an error, never a message", () => {
  assert.ok("error" in parseRelayMessage("<@U0SALVA01> hola", people), "no header");
  assert.ok("error" in parseRelayMessage("await: none\n\n   ", people), "empty message");
  assert.ok("error" in parseRelayMessage("await: <@U0OTHER01>\n\nhola", people), "awaits someone the owner did not name");
  assert.ok("error" in parseRelayMessage("await: quién sabe\n\nhola", people), "unreadable header");
  assert.ok("error" in parseRelayMessage("await: none\n\n<@U0OWNER01> me pidió que te avise", people), "names the owner");
});
