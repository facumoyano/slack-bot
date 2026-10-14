import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { drainContent } from "./bot.ts";
import type { BotDeps } from "./bot.ts";
import { contentKey, contentMessage, isNewVersion, readManifest, retiredMessage, supersededLine } from "./content.ts";
import type { Manifest } from "./content.ts";

/** `entrada/` is where the marketing session drops manifests; the bot moves each to `procesados/` or `errores/`. */
export const CONTENT_ROOT = join(import.meta.dirname, "..", "data", "contenido");
export const INTAKE_INTERVAL_MS = 10_000;
/** A file that is still not JSON this long after its last write was not half-written: it is broken. */
export const UNPARSEABLE_AFTER_MS = 2 * 60_000;

export type IntakeDeps = Pick<BotDeps, "poster" | "store" | "dirs" | "allowedUsers" | "now">;

async function moveTo(root: string, folder: "procesados" | "errores", name: string): Promise<void> {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  const taken = await stat(join(dir, name)).then(() => true, () => false);
  await rename(join(root, "entrada", name), join(dir, taken ? `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}` : name));
}

async function refuse(deps: IntakeDeps, root: string, name: string, reason: string): Promise<void> {
  await moveTo(root, "errores", name);
  console.error(`content manifest ${name} rejected: ${reason}`);
  for (const owner of deps.allowedUsers) {
    await deps.poster.dm(owner, `⚠️ descarté el manifiesto de contenido \`${name}\`: ${reason}`).catch((err) => console.error(`DM to ${owner} failed:`, err));
  }
}

/**
 * Posts a manifest's version: v1 as a new message in its channel, a later one in the first one's thread, retiring the
 * previous version's buttons. A version already posted, or older, posts nothing. The images go into the thread right after.
 */
export async function postManifest(deps: IntakeDeps, m: Manifest): Promise<"posted" | "repeated"> {
  const key = contentKey(m.tipo, m.id);
  const current = deps.store.data.contents[key];
  if (!isNewVersion(current, m)) return "repeated";
  const msg = contentMessage(m);
  const channel = current?.channel ?? m.canal;
  const msgTs = current
    ? await deps.poster.postToThread({ slack: { channel, threadTs: current.threadTs, requester: "" } }, msg.text, msg.blocks)
    : await deps.poster.postTopLevel(channel, msg.text, msg.blocks);
  const threadTs = current?.threadTs ?? msgTs;
  deps.store.data.contents[key] = { kind: m.tipo, id: m.id, channel, threadTs, version: m.version, msgTs, text: msg.text, state: { kind: "pending" } };
  deps.store.save();
  if (current) {
    const retired = retiredMessage(current.text, supersededLine(m.version));
    await deps.poster.update(current.channel, current.msgTs, retired.text, retired.blocks).catch((err) => console.error(`retiring ${key} v${current.version} failed:`, err));
  }
  const where = { slack: { channel, threadTs, requester: "" } };
  for (const path of m.tipo === "propuesta" ? m.imagenes : []) {
    await deps.poster.uploadFile(where, path).catch(async (err) => {
      console.error(`uploading ${path} for ${key} failed:`, err);
      await deps.poster.postToThread(where, `⚠️ no pude subir ${basename(path)}: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
  }
  return "posted";
}

/** One pass over `entrada/`: valid manifests are posted oldest version first and moved to `procesados/`, broken ones to `errores/` with a DM to the owners. */
export async function sweepManifests(deps: IntakeDeps, root = CONTENT_ROOT): Promise<void> {
  const inbox = join(root, "entrada");
  await mkdir(inbox, { recursive: true });
  const now = (deps.now ?? Date.now)();
  const names = (await readdir(inbox, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const ready: { name: string; manifest: Manifest }[] = [];
  for (const name of names) {
    const path = join(inbox, name);
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch {
        if (now - (await stat(path)).mtimeMs > UNPARSEABLE_AFTER_MS) await refuse(deps, root, name, "no es JSON válido (esperé 2 minutos por si se estaba escribiendo)");
        continue;
      }
      const read = await readManifest(raw, deps.dirs);
      if ("error" in read) await refuse(deps, root, name, read.error);
      else ready.push({ name, manifest: read.manifest });
    } catch (err) {
      console.error(`reading content manifest ${name} failed:`, err);
    }
  }
  for (const { name, manifest } of ready.sort((a, b) => a.manifest.version - b.manifest.version)) {
    try {
      await postManifest(deps, manifest);
      await moveTo(root, "procesados", name);
    } catch (err) {
      console.error(`posting content manifest ${name} failed; retrying on the next pass:`, err);
    }
  }
}

/** Every 10 s: take new manifests, then start queued content actions whose directory is free (also the queue left by a restart). */
export async function runIntake(deps: BotDeps, root = CONTENT_ROOT, shouldStop: () => boolean = () => false): Promise<void> {
  while (!shouldStop()) {
    try {
      await sweepManifests(deps, root);
      for (const path of Object.keys(deps.store.data.contentQueues)) drainContent(deps, path);
    } catch (err) {
      console.error("content intake failed:", err);
    }
    await sleep(INTAKE_INTERVAL_MS);
  }
}
