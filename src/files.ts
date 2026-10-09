import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const FILES_ROOT = join(import.meta.dirname, "..", "data", "files");

/** The file name both `data/reports/` and `data/files/` use for a job. */
export function jobSlug(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9]+/g, "-");
}

export function inboxDir(root: string, jobId: string): string {
  return join(root, jobSlug(jobId), "in");
}

export function outboxDir(root: string, jobId: string): string {
  return join(root, jobSlug(jobId), "out");
}

/** A Slack file the bot can download. */
export type SlackFile = { id: string; name: string; mimetype: string; size: number; url: string };

/** A file on disk the worker can read. `fresh` is false when an earlier message already brought it. */
export type LocalFile = { path: string; name: string; mimetype: string; fresh: boolean };

export type FileProblem = { name: string; reason: string };

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** The `files[]` of Slack messages, as the events API and `conversations.replies` give them. */
export function messageFiles(messages: ReadonlyArray<{ files?: unknown }>): unknown[] {
  return messages.flatMap((m) => (Array.isArray(m.files) ? m.files : []));
}

/** A name safe as one path segment: no separators, no `..`, nothing hidden. */
export function sanitizeName(name: string): string {
  const safe = name
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+/, "");
  if (safe.length <= 100) return safe || "archivo";
  const ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(safe)?.[0] ?? "";
  return safe.slice(0, 100 - ext.length) + ext;
}

/** Splits Slack file objects into ones the bot can download and ones it says it skipped. Duplicates count once. */
export function selectFiles(raw: readonly unknown[]): { files: SlackFile[]; skipped: FileProblem[] } {
  const files: SlackFile[] = [];
  const skipped: FileProblem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const f = (item ?? {}) as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = str(f.name) ?? str(f.title) ?? id;
    const url = str(f.url_private_download) ?? str(f.url_private);
    const size = typeof f.size === "number" ? f.size : 0;
    if (f.file_access === "check_file_info") skipped.push({ name, reason: "Slack no me pasó los datos del archivo" });
    else if (f.mode === "external" || !url) skipped.push({ name, reason: "no es un archivo que Slack me deje bajar (externo o sin link de descarga)" });
    else if (size > MAX_DOWNLOAD_BYTES) skipped.push({ name, reason: "pesa más de 50 MB" });
    else files.push({ id, name, mimetype: str(f.mimetype) ?? "application/octet-stream", size, url });
  }
  return { files, skipped };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export const SCOPE_HINT = "Slack devolvió una página de login en vez del archivo: la app necesita el scope files:read (reinstalala)";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Downloads into `dir`, skipping files already there. One failure never stops the others. */
export async function downloadFiles(
  dir: string,
  files: readonly SlackFile[],
  fetchFile: (url: string) => Promise<Response>,
): Promise<{ files: LocalFile[]; failed: FileProblem[] }> {
  const done: LocalFile[] = [];
  const failed: FileProblem[] = [];
  for (const f of files) {
    const path = join(dir, `${f.id}-${sanitizeName(f.name)}`);
    const local = { path, name: f.name, mimetype: f.mimetype };
    try {
      if (await exists(path)) {
        done.push({ ...local, fresh: false });
        continue;
      }
      const res = await fetchFile(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if ((res.headers.get("content-type") ?? "").startsWith("text/html") && !f.mimetype.startsWith("text/html")) throw new Error(SCOPE_HINT);
      await mkdir(dir, { recursive: true });
      // Written aside and renamed, so a crash mid-download never leaves a partial file that later counts as on disk.
      await writeFile(`${path}.part`, Buffer.from(await res.arrayBuffer()));
      await rename(`${path}.part`, path);
      done.push({ ...local, fresh: true });
    } catch (err) {
      failed.push({ name: f.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { files: done, failed };
}

/** The thread notice for files the bot could not bring, or undefined when all arrived. */
export function problemsNotice(problems: readonly FileProblem[]): string | undefined {
  if (!problems.length) return undefined;
  return ["⚠️ no pude bajar algunos archivos; sigo sin ellos:", ...problems.map((p) => `• ${p.name}: ${p.reason}`)].join("\n");
}

/** A thread message for the worker, naming the files that came with it. */
export function withFiles(text: string, files: readonly LocalFile[]): string {
  if (!files.length) return text;
  const list = files.map((f) => `- ${f.path} (${f.name}, ${f.mimetype})`).join("\n");
  return [text, `Files attached in Slack (inspect them with the Read tool):\n${list}`].filter(Boolean).join("\n\n");
}

/** What a thread message looks like in Slack: its text, or the names of its files when it had none. */
export function shownText(text: string, files: readonly LocalFile[]): string {
  return text || files.map((f) => `📎 ${f.name}`).join(", ");
}

/** Outbox files ready to upload, oldest name first; dotfiles, folders and files over 1 GB are left alone. */
export async function outboxFiles(dir: string): Promise<{ ready: string[]; tooBig: string[] }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ready: string[] = [];
  const tooBig: string[] = [];
  for (const e of entries.filter((e) => e.isFile() && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    ((await stat(path)).size > MAX_UPLOAD_BYTES ? tooBig : ready).push(path);
  }
  return { ready, tooBig };
}

/** Moves an outbox file into `sent/` or `skipped/`, so a replayed inbox batch never handles it again. */
export async function retire(path: string, folder: "sent" | "skipped"): Promise<void> {
  const to = join(path, "..", folder);
  await mkdir(to, { recursive: true });
  await rename(path, join(to, basename(path)));
}
