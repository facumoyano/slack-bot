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

/** A name in the owner's DM that matched nobody in Slack, with the reason matching gave. */
export type UnknownName = { name: string; why: string };

/** What the worker's first step wrote: a message for the thread and whose reply it waits for, or a private answer to the owner. */
export type RelayFile = { kind: "thread"; text: string; awaiting: string[] } | { kind: "private"; text: string };

export type RelayFileRules = { people: readonly string[]; unknown: readonly UnknownName[]; owner: string };

const TOKEN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * The relay file is a header line, a blank line, then Markdown. `private` heads an answer only the owner reads.
 * `await: <@U1> <@U2>` (or `await: none`) heads the exact thread message, which may mention and await only the people
 * the owner named, and never a name that matched nobody in Slack.
 */
export function parseRelayFile(raw: string, o: RelayFileRules): RelayFile | { error: string } {
  const [head, ...rest] = raw.replace(/^\s+/, "").split("\n");
  const text = rest.join("\n").trim();
  if (/^private$/i.test(head.trim())) return text ? { kind: "private", text } : { error: "la respuesta privada está vacía" };
  const header = /^await:\s*(.*)$/i.exec(head.trim());
  if (!header) return { error: "la primera línea no es `private` ni `await: …`" };
  if (!text) return { error: "el mensaje para el hilo está vacío" };
  const named = mentionedUsers(raw).map((n) => n.toLowerCase());
  const lost = o.unknown.find((u) => named.includes(u.name.toLowerCase()));
  if (lost) return { error: lost.why };
  const value = header[1].trim();
  const none = /^(none|nadie)?$/i.test(value);
  const awaiting = none ? [] : [...value.matchAll(/<@([UW][A-Z0-9]+)>|\b([UW][A-Z0-9]{8,})\b/g)].map((m) => m[1] ?? m[2]);
  if (!none && !awaiting.length) return { error: `no entiendo a quién espera: \`${value}\`` };
  const mentioned = [...text.matchAll(TOKEN)].map((m) => m[1]);
  if (!o.people.includes(o.owner) && mentioned.includes(o.owner)) return { error: "el mensaje te menciona" };
  const stranger = [...awaiting, ...mentioned].find((id) => !o.people.includes(id));
  if (stranger) return { error: `${awaiting.includes(stranger) ? "espera la respuesta de" : "menciona a"} <@${stranger}>, que no nombraste` };
  return { kind: "thread", text, awaiting: [...new Set(awaiting)] };
}
