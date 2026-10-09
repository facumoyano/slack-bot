import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MESSAGE_MAX, plainMessage, splitText } from "./blocks.ts";
import type { Message } from "./blocks.ts";
import { toSlackMrkdwn } from "./report.ts";

export type Thread = { channel: string; threadTs: string };

export type SlackUser = { id: string; name: string; displayName: string; realName: string; isBot: boolean; deleted: boolean };

/** A message of `conversations.replies`, with only what the CLI shows or filters on. */
export type ThreadMsg = { ts: string; user?: string; botId?: string; username?: string; text: string; files: string[] };

export type Self = { userId: string; botId?: string };

/** The Slack calls the CLI makes; the script wires them to the Web API, tests to a fake. */
export type SlackApi = {
  self(): Promise<Self>;
  users(): Promise<SlackUser[]>;
  replies(thread: Thread): Promise<ThreadMsg[]>;
  post(thread: Thread, message: Message): Promise<string>;
  permalink(channel: string, ts: string): Promise<string>;
  upload(thread: Thread, path: string): Promise<void>;
};

type Common = { thread?: Thread; state?: string };

export type Command =
  | (Common & { kind: "post"; to: string[]; text: { inline: string } | { file: string }; files: string[]; dryRun: boolean })
  | (Common & { kind: "read"; since?: string; from?: string; all: boolean })
  | (Common & { kind: "wait"; from: string; since?: string; timeoutMinutes: number });

export class UsageError extends Error {}

export const USAGE = `uso:
  thread.ts post [--thread <canal>:<ts>] [--to <nombre|@nombre|Uxxxx> …] (--text <texto> | --text-file <ruta>) [--file <ruta> …] [--dry-run]
  thread.ts read [--thread <canal>:<ts>] [--since <ts>] [--from <nombre|Uxxxx>] [--all]
  thread.ts wait [--thread <canal>:<ts>] --from <nombre|Uxxxx> [--since <ts>] [--timeout <minutos>]
Sin --thread, el hilo sale del job de Alfred cuyo worktree contiene el directorio actual (en data/state.json de este repo, u otro con --state <ruta>).`;

const ALLOWED: Record<Command["kind"], readonly string[]> = {
  post: ["thread", "state", "to", "text", "text-file", "file", "dry-run"],
  read: ["thread", "state", "since", "from", "all"],
  wait: ["thread", "state", "since", "from", "timeout"],
};

const TS = /^\d+(\.\d+)?$/;

export function parseThread(value: string): Thread {
  const m = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(value.trim());
  if (!m) throw new UsageError(`--thread debe ser <canal>:<ts>, como C0123ABC:1791548002.024869 (recibí "${value}")`);
  return { channel: m[1], threadTs: m[2] };
}

function since(value: string | undefined): string | undefined {
  if (value !== undefined && !TS.test(value)) throw new UsageError(`--since debe ser un ts de Slack, como 1791548002.024869 (recibí "${value}")`);
  return value;
}

const OPTIONS = {
  thread: { type: "string" },
  state: { type: "string" },
  to: { type: "string", multiple: true },
  text: { type: "string" },
  "text-file": { type: "string" },
  file: { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  since: { type: "string" },
  from: { type: "string" },
  all: { type: "boolean" },
  timeout: { type: "string" },
} as const;

/** `--text "- a bullet"` as `--text=- a bullet`: parseArgs refuses a separate value that starts with a dash, and Markdown lists do. */
function joinValues(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    const option = Object.hasOwn(OPTIONS, name) ? OPTIONS[name as keyof typeof OPTIONS] : undefined;
    if (option?.type === "string" && i + 1 < argv.length) out.push(`${argv[i]}=${argv[++i]}`);
    else out.push(argv[i]);
  }
  return out;
}

export function parseCommand(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({ args: joinValues(argv), allowPositionals: true, options: OPTIONS });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values: v, positionals } = parsed;
  const kind = positionals[0];
  if (kind !== "post" && kind !== "read" && kind !== "wait") throw new UsageError(`comando desconocido "${kind ?? ""}": usá post, read o wait`);
  if (positionals.length > 1) throw new UsageError(`sobra "${positionals[1]}"; si es texto, pasalo con --text "…"`);
  const stray = Object.keys(v).find((k) => !ALLOWED[kind].includes(k));
  if (stray) throw new UsageError(`--${stray} no aplica a ${kind}`);
  const common: Common = { thread: v.thread === undefined ? undefined : parseThread(v.thread), state: v.state };
  switch (kind) {
    case "post": {
      if (v.text !== undefined && v["text-file"] !== undefined) throw new UsageError("usá --text o --text-file, no los dos");
      const text = v.text !== undefined ? { inline: v.text } : v["text-file"] !== undefined ? { file: v["text-file"] } : undefined;
      if (!text || ("inline" in text && !text.inline.trim())) throw new UsageError("post necesita --text <texto> o --text-file <ruta>");
      return { ...common, kind, to: v.to ?? [], text, files: v.file ?? [], dryRun: v["dry-run"] ?? false };
    }
    case "read":
      return { ...common, kind, since: since(v.since), from: v.from, all: v.all ?? false };
    case "wait": {
      if (!v.from) throw new UsageError("wait necesita --from <nombre|Uxxxx>");
      const timeoutMinutes = v.timeout === undefined ? 30 : Number(v.timeout);
      if (!(timeoutMinutes > 0)) throw new UsageError(`--timeout debe ser un número de minutos mayor a 0 (recibí "${v.timeout}")`);
      return { ...common, kind, from: v.from, since: since(v.since), timeoutMinutes };
    }
  }
}

/** A job as `data/state.json` stores it, reduced to what the match reads. */
export type StateJob = { slack: { channel: string; threadTs: string }; worktreeId?: string };

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** The thread of the job whose worktree (the path after `::` in `worktreeId`) is the git toplevel or contains `cwd`; the deepest worktree wins. */
export function threadForCwd(jobs: Record<string, StateJob>, toplevel: string | undefined, cwd: string): Thread {
  const matches = Object.values(jobs)
    .map((job) => ({ job, path: job.worktreeId?.split("::")[1] }))
    .filter((m): m is { job: StateJob; path: string } => !!m.path && (m.path === toplevel || within(cwd, m.path)))
    .sort((a, b) => b.path.length - a.path.length);
  if (!matches.length) throw new UsageError(`no encontré un job de Alfred cuyo worktree contenga ${cwd}; pasá --thread <canal>:<ts>`);
  const deepest = matches.filter((m) => m.path === matches[0].path);
  const threads = [...new Set(deepest.map((m) => `${m.job.slack.channel}:${m.job.slack.threadTs}`))];
  if (threads.length > 1) throw new UsageError(`el worktree ${matches[0].path} es de varios hilos (${threads.join(", ")}); elegí uno con --thread`);
  return { channel: deepest[0].job.slack.channel, threadTs: deepest[0].job.slack.threadTs };
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function userLabel(u: SlackUser): string {
  return u.displayName || u.realName || u.name || u.id;
}

const USER_ID = /^[UW][A-Z0-9]+$/;

/** A Slack user by id, or by `name`, display name or real name: exact match first, then a unique prefix; people before bots. */
export function matchUser(users: readonly SlackUser[], query: string): SlackUser {
  const q = query.trim();
  if (USER_ID.test(q)) return users.find((u) => u.id === q) ?? { id: q, name: "", displayName: "", realName: "", isBot: false, deleted: false };
  const wanted = norm(q.replace(/^@/, ""));
  if (!wanted) throw new UsageError(`"${query}" no es un nombre de usuario`);
  const live = users.filter((u) => !u.deleted);
  const keys = (u: SlackUser) => [u.name, u.displayName, u.realName].filter(Boolean).map(norm);
  const pick = (found: SlackUser[]) => {
    const people = found.filter((u) => !u.isBot);
    return people.length ? people : found;
  };
  const describe = (us: readonly SlackUser[]) => us.map((u) => `${userLabel(u)} (@${u.name}, ${u.id})`).join(", ");
  for (const test of [(k: string) => k === wanted, (k: string) => k.startsWith(wanted)]) {
    const found = pick(live.filter((u) => keys(u).some(test)));
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new UsageError(`"${query}" es ambiguo: ${describe(found)}; usá el nombre completo o el id`);
  }
  const near = live.filter((u) => keys(u).some((k) => k.includes(wanted))).slice(0, 10);
  throw new UsageError(`no encontré a "${query}" en Slack${near.length ? `; parecidos: ${describe(near)}` : ""}`);
}

/** The thread's messages after `since`, oldest first; the bot's own only when `all`, and only `from`'s when given. */
export function selectMessages(messages: readonly ThreadMsg[], self: Self, o: { since?: string; from?: string; all?: boolean }): ThreadMsg[] {
  const after = o.since === undefined ? -Infinity : Number(o.since);
  const own = (m: ThreadMsg) => m.user === self.userId || (self.botId !== undefined && m.botId === self.botId);
  return messages
    .filter((m) => Number(m.ts) > after && (o.all || !own(m)) && (o.from === undefined || m.user === o.from))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

export function formatMessage(m: ThreadMsg, users: readonly SlackUser[]): string {
  const user = users.find((u) => u.id === m.user);
  const who = user ? userLabel(user) : (m.username ?? m.user ?? m.botId ?? "?");
  const files = m.files.length ? `\n📎 ${m.files.join(", ")}` : "";
  return `[${m.ts}] ${who}: ${m.text}${files}`;
}

/** A first line that only reads right at the start of its own line. */
const BLOCK_START = /^([-*+]\s|\d+[.)]\s|#|```|>)/;

/** The posts for a Markdown text: mentions first, rendered as mrkdwn, split on lines into as many messages as it takes. */
export function buildPosts(markdown: string, mentionIds: readonly string[]): Message[] {
  const text = markdown.trim();
  const mentions = mentionIds.map((id) => `<@${id}>`).join(" ");
  const body = toSlackMrkdwn(text);
  const head = !mentions ? "" : BLOCK_START.test(text) ? `${mentions}\n` : `${mentions} `;
  return splitText(head + body, MESSAGE_MAX)
    .filter((chunk) => chunk.trim())
    .map(plainMessage);
}

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const POLL_MS = 20_000;

/** Polls the thread until `from` posts after `since`; undefined when `timeoutMs` passes first. */
export async function waitForReply(
  api: Pick<SlackApi, "replies">,
  o: { thread: Thread; self: Self; from: string; since: string; timeoutMs: number; pollMs?: number },
  clock: Clock,
): Promise<ThreadMsg[] | undefined> {
  const deadline = clock.now() + o.timeoutMs;
  for (;;) {
    const found = selectMessages(await api.replies(o.thread), o.self, { since: o.since, from: o.from });
    if (found.length) return found;
    const left = deadline - clock.now();
    if (left <= 0) return undefined;
    await clock.sleep(Math.min(o.pollMs ?? POLL_MS, left));
  }
}

export type RunDeps = {
  api: SlackApi;
  /** The thread when `--thread` is not given. */
  findThread(statePath: string | undefined): Promise<Thread>;
  clock: Clock;
  out(line: string): void;
};

export const EXIT_TIMEOUT = 2;

function nowTs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

/** Runs one command; returns the exit code. Usage and Slack errors are thrown for the script to print. */
export async function run(cmd: Command, deps: RunDeps): Promise<number> {
  const { api, out } = deps;
  const thread = cmd.thread ?? (await deps.findThread(cmd.state));
  let users: Promise<SlackUser[]> | undefined;
  const allUsers = () => (users ??= api.users());
  const resolveUser = async (q: string) => (USER_ID.test(q.trim()) ? q.trim() : matchUser(await allUsers(), q).id);
  out(`hilo: ${thread.channel}:${thread.threadTs}`);

  switch (cmd.kind) {
    case "post": {
      const markdown = "inline" in cmd.text ? cmd.text.inline : await readFile(cmd.text.file, "utf8");
      if (!markdown.trim()) throw new UsageError(`el texto a postear está vacío`);
      const files = cmd.files.map((f) => resolve(f));
      for (const f of files) {
        if (!(await stat(f).then((s) => s.isFile(), () => false))) throw new UsageError(`no existe el archivo ${f}`);
      }
      const ids = [];
      for (const q of cmd.to) ids.push(await resolveUser(q));
      const posts = buildPosts(markdown, ids);
      if (cmd.dryRun) {
        posts.forEach((p, i) => out(`--- mensaje ${i + 1}/${posts.length} (no se postea, --dry-run) ---\n${p.text}`));
        for (const f of files) out(`📎 subiría ${basename(f)}`);
        return 0;
      }
      for (const p of posts) {
        const ts = await api.post(thread, p);
        out(`ts: ${ts}\npermalink: ${await api.permalink(thread.channel, ts)}`);
      }
      for (const f of files) {
        await api.upload(thread, f);
        out(`📎 subido ${basename(f)}`);
      }
      return 0;
    }
    case "read": {
      const [self, from] = await Promise.all([api.self(), cmd.from === undefined ? undefined : resolveUser(cmd.from)]);
      const messages = selectMessages(await api.replies(thread), self, { since: cmd.since, from, all: cmd.all });
      const known = await allUsers();
      if (!messages.length) out("(no hay mensajes que coincidan)");
      for (const m of messages) out(formatMessage(m, known));
      return 0;
    }
    case "wait": {
      const [self, from] = await Promise.all([api.self(), resolveUser(cmd.from)]);
      const since = cmd.since ?? nowTs(deps.clock.now());
      out(`esperando a ${from} desde ${since} (hasta ${cmd.timeoutMinutes} min)…`);
      const found = await waitForReply(api, { thread, self, from, since, timeoutMs: cmd.timeoutMinutes * 60_000 }, deps.clock);
      if (!found) {
        out(`sin respuesta de ${from} en ${cmd.timeoutMinutes} min`);
        return EXIT_TIMEOUT;
      }
      const known = await allUsers();
      for (const m of found) out(formatMessage(m, known));
      return 0;
    }
  }
}
