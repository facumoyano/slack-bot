import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { ACTIONS, plainMessage, textBlocks } from "./blocks.ts";
import type { Message } from "./blocks.ts";
import { MAX_UPLOAD_BYTES } from "./files.ts";
import type { LocalDir } from "./jobs.ts";
import { toSlackMrkdwn } from "./report.ts";

/** A social-media post the marketing session proposes; `imagenes` are real paths inside the channel's bound directory once parsed. */
export type Proposal = {
  tipo: "propuesta";
  id: string;
  version: number;
  canal: string;
  red: string;
  fecha: string;
  hora: string;
  titulo: string;
  texto: string;
  imagenes: string[];
  archivo: string;
  buffer_id: string;
  notas?: string;
};

/** A content calendar to approve as a whole. */
export type Calendar = { tipo: "calendario"; id: string; version: number; canal: string; titulo: string; texto: string; archivo: string };

export type Manifest = Proposal | Calendar;

export type ContentKind = Manifest["tipo"];

/** `<tipo>:<id>`, the key of a content item in the store and in its buttons. */
export type ContentKey = `${ContentKind}:${string}`;

export type ContentState = { kind: "pending" } | { kind: "approved"; by: string } | { kind: "rejected"; by: string };

/**
 * A content item's newest version as posted: v1 is the thread root, later versions are replies in it.
 * `text` is what the message shows without buttons, so retiring them never needs the manifest again.
 */
export type Content = { kind: ContentKind; id: string; channel: string; threadTs: string; version: number; msgTs: string; text: string; state: ContentState };

/** What a click or a reply asks the marketing session to do; each becomes one `/contenido …` request in the bound directory. */
export type ContentAction =
  | { kind: "aprobar" | "rechazar" | "calendario-aprobado"; id: string; by: string }
  | { kind: "cambiar" | "calendario-cambiar"; id: string; by: string; text: string };

/** A content action waiting for its directory, FIFO per directory. `ts` is the message it answers (the reply, or the clicked post). */
export type QueuedAction = { action: ContentAction; channel: string; threadTs: string; ts: string; files?: unknown[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function contentKey(kind: ContentKind, id: string): ContentKey {
  return `${kind}:${id}`;
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/**
 * The manifest's shape, checked once at the boundary. Image paths are only checked to be strings here;
 * `checkImages` confines them to the bound directory. Errors are one Spanish line for the owner's DM.
 */
export function parseManifest(raw: unknown, dirs: Readonly<Record<string, LocalDir>>): { manifest: Manifest } | { error: string } {
  const m = record(raw);
  if (!m) return { error: "no es un objeto JSON" };
  const missing: string[] = [];
  const text = (field: string, optional = false): string => {
    const v = m[field];
    if (typeof v === "string" && v.trim()) return v;
    if (!optional || (v !== undefined && typeof v !== "string")) missing.push(field);
    return "";
  };
  if (m.tipo !== "propuesta" && m.tipo !== "calendario") return { error: `\`tipo\` tiene que ser "propuesta" o "calendario"` };
  const id = text("id");
  const canal = text("canal");
  const titulo = text("titulo");
  const texto = text("texto");
  const archivo = text("archivo");
  const version = m.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) missing.push("version");
  const common = { id, version: version as number, canal, titulo, texto, archivo };
  let manifest: Manifest;
  if (m.tipo === "calendario") {
    manifest = { tipo: "calendario", ...common };
  } else {
    const imagenes = Array.isArray(m.imagenes) && m.imagenes.every((p) => typeof p === "string" && p.trim()) ? (m.imagenes as string[]) : undefined;
    if (!imagenes) missing.push("imagenes");
    const notas = text("notas", true);
    manifest = { tipo: "propuesta", ...common, red: text("red"), fecha: text("fecha"), hora: text("hora"), imagenes: imagenes ?? [], buffer_id: text("buffer_id"), ...(notas ? { notas } : {}) };
  }
  if (missing.length) return { error: `faltan o están mal: ${missing.map((f) => `\`${f}\``).join(", ")}` };
  if (!ID.test(id)) return { error: `\`id\` "${id}" no es un slug (letras, números, - y _)` };
  if (!dirs[canal]) return { error: `el canal ${canal} no está atado a una carpeta en ALFRED_DIRS` };
  return { manifest };
}

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ["png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

async function head(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await file.read(buf, 0, 12, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * Each image as its real path, or the reason it may not be uploaded. Symlinks and `..` are resolved before the check,
 * so a manifest can only ever upload an image that really lives in its channel's directory: never `.env` or anything else.
 */
export async function checkImages(paths: readonly string[], dir: string): Promise<{ paths: string[] } | { error: string }> {
  const root = await realpath(dir);
  const out: string[] = [];
  for (const p of paths) {
    const real = await realpath(isAbsolute(p) ? p : resolve(dir, p)).catch(() => undefined);
    if (!real) return { error: `la imagen \`${p}\` no existe` };
    if (!real.startsWith(root + sep)) return { error: `la imagen \`${p}\` está fuera de la carpeta del canal` };
    if (!IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) return { error: `\`${p}\` no es una imagen png, jpg, gif o webp` };
    const info = await stat(real);
    if (!info.isFile()) return { error: `\`${p}\` no es un archivo` };
    if (info.size > MAX_UPLOAD_BYTES) return { error: `la imagen \`${p}\` pesa más de 1 GB` };
    const bytes = await head(real);
    if (!MAGIC.some(([, is]) => is(bytes))) return { error: `\`${p}\` no tiene contenido de imagen` };
    out.push(real);
  }
  return { paths: out };
}

/** A manifest file's JSON, fully validated: shape, bound channel and every image. */
export async function readManifest(raw: unknown, dirs: Readonly<Record<string, LocalDir>>): Promise<{ manifest: Manifest } | { error: string }> {
  const parsed = parseManifest(raw, dirs);
  if ("error" in parsed || parsed.manifest.tipo !== "propuesta") return parsed;
  const images = await checkImages(parsed.manifest.imagenes, dirs[parsed.manifest.canal].path);
  return "error" in images ? images : { manifest: { ...parsed.manifest, imagenes: images.paths } };
}

/** Whether a manifest is new: a first version, or one newer than the version already posted. */
export function isNewVersion(current: Pick<Content, "version"> | undefined, m: Pick<Manifest, "version">): boolean {
  return !current || m.version > current.version;
}

function quote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

/** The message as it reads without buttons: what the post says and when it goes out. */
export function contentText(m: Manifest): string {
  const footer = `_\`${m.id}\` · versión ${m.version}_`;
  if (m.tipo === "calendario") return [`🗓️ *${m.titulo}*`, toSlackMrkdwn(m.texto), footer].join("\n\n");
  return [
    `📣 *${m.titulo}*`,
    `*Red:* ${m.red} · *Fecha:* ${m.fecha} · *Hora:* ${m.hora}`,
    quote(toSlackMrkdwn(m.texto)),
    ...(m.notas ? [`*Notas:* ${toSlackMrkdwn(m.notas)}`] : []),
    footer,
  ].join("\n\n");
}

/** A content message with its buttons: Aprobar and Rechazar for a post, Aprobar for a calendar. */
export function contentMessage(m: Manifest): Message {
  const text = contentText(m);
  const value = JSON.stringify({ k: contentKey(m.tipo, m.id), v: m.version });
  const approve = { type: "button" as const, action_id: ACTIONS.contentApprove, style: "primary" as const, text: { type: "plain_text" as const, text: "Aprobar" }, value };
  const reject = { type: "button" as const, action_id: ACTIONS.contentReject, style: "danger" as const, text: { type: "plain_text" as const, text: "Rechazar" }, value };
  return { text, blocks: [...textBlocks(text), { type: "actions", elements: m.tipo === "propuesta" ? [approve, reject] : [approve] }] };
}

/** The message once its buttons are gone, with the line that says why. */
export function retiredMessage(text: string, line: string): Message {
  return plainMessage(`${text}\n\n${line}`);
}

export function decidedLine(decision: "approved" | "rejected", name: string): string {
  return decision === "approved" ? `✅ aprobado por ${name}` : `🚫 rechazado por ${name}`;
}

export function supersededLine(version: number): string {
  return `_reemplazada por la versión ${version}_`;
}

/** The first click wins; undefined once the version is decided, or for Rechazar on a calendar, which has no such button. */
export function decideContent(content: Content, decision: "approve" | "reject", by: string): Content | undefined {
  if (content.state.kind !== "pending" || (decision === "reject" && content.kind === "calendario")) return undefined;
  return { ...content, state: decision === "approve" ? { kind: "approved", by } : { kind: "rejected", by } };
}

export function clickAction(content: Pick<Content, "kind" | "id">, decision: "approve" | "reject", by: string): ContentAction {
  if (content.kind === "calendario") return { kind: "calendario-aprobado", id: content.id, by };
  return { kind: decision === "approve" ? "aprobar" : "rechazar", id: content.id, by };
}

export function replyAction(content: Pick<Content, "kind" | "id">, by: string, text: string): ContentAction {
  return { kind: content.kind === "calendario" ? "calendario-cambiar" : "cambiar", id: content.id, by, text };
}

/** The request the marketing session's skill receives, literally. */
export function contentPrompt(action: ContentAction, name: string): string {
  const head = `/contenido ${action.kind} ${action.id} por ${name}`;
  return "text" in action ? `${head}: ${action.text}` : head;
}

/** The content item whose thread this is, in the given channel. */
export function contentInThread(contents: Readonly<Record<string, Content>>, channel: string, threadTs: string): Content | undefined {
  return Object.values(contents).find((c) => c.channel === channel && c.threadTs === threadTs);
}
