/** A Slack message permalink resolved to its thread. */
export type ThreadLink = { channel: string; threadTs: string; url: string };

const PERMALINK = /https?:\/\/[^\s<>|]+\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})[^\s<>|]*/;

/** The first message permalink in a Slack text; a reply's link names its thread through `thread_ts`. */
export function parseThreadLink(text: string): ThreadLink | undefined {
  const m = PERMALINK.exec(text);
  if (!m) return undefined;
  const url = m[0];
  const threadTs = new URL(url).searchParams.get("thread_ts");
  return { channel: m[1], threadTs: threadTs && /^\d+\.\d+$/.test(threadTs) ? threadTs : `${m[2]}.${m[3]}`, url };
}

/** The DM's text without the link, as Slack wraps it (`<url>` or `<url|label>`) or bare. */
export function instructionOf(text: string, link: ThreadLink): string {
  const at = text.indexOf(link.url);
  const start = text[at - 1] === "<" ? at - 1 : at;
  const close = text.indexOf(">", at);
  const end = start < at && close !== -1 ? close + 1 : at + link.url.length;
  return `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, " ").trim();
}

/** Who the instruction names: Slack's `<@U…>` tokens and typed `@name`s, in order, each once. */
export function mentionedUsers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|(?<![\w<@.])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu)) {
    const query = m[1] ?? m[2].replace(/[._-]+$/, "");
    if (!found.includes(query)) found.push(query);
  }
  return found;
}

/** What the worker's first step wrote: the exact thread message and whose reply it waits for. */
export type RelayMessage = { text: string; awaiting: string[] };

/**
 * The thread file is `await: <@U1> <@U2>` (or `await: none`), a blank line, then the message in Markdown.
 * Only the people the owner named may be awaited, and the message never names the owner.
 */
export function parseRelayMessage(raw: string, o: { people: readonly string[]; owner: string }): RelayMessage | { error: string } {
  const [head, ...rest] = raw.replace(/^\s+/, "").split("\n");
  const header = /^await:\s*(.*)$/i.exec(head.trim());
  if (!header) return { error: "la primera línea del mensaje no es `await: …`" };
  const text = rest.join("\n").trim();
  if (!text) return { error: "el mensaje para el hilo está vacío" };
  const value = header[1].trim();
  const awaiting = /^(none|nadie)?$/i.test(value) ? [] : [...value.matchAll(/<@([UW][A-Z0-9]+)>|\b([UW][A-Z0-9]{8,})\b/g)].map((m) => m[1] ?? m[2]);
  if (value && !/^(none|nadie)$/i.test(value) && !awaiting.length) return { error: `no entiendo a quién espera: \`${value}\`` };
  const stranger = awaiting.find((id) => !o.people.includes(id));
  if (stranger) return { error: `espera la respuesta de ${stranger}, que no nombraste` };
  if (!o.people.includes(o.owner) && text.includes(`<@${o.owner}>`)) return { error: "el mensaje te menciona" };
  return { text, awaiting: [...new Set(awaiting)] };
}
