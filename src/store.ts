import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "./jobs.ts";

export type StoreHandle = { data: Store; save(): void };

export function openStore(path: string): StoreHandle {
  let data: Store = { jobs: {}, processedMsgIds: [], channels: {} };
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  data.channels ??= {};
  mkdirSync(dirname(path), { recursive: true });
  const handle: StoreHandle = {
    data,
    save() {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(handle.data, null, 2));
      renameSync(tmp, path);
    },
  };
  return handle;
}

export function memoryStore(data: Store = { jobs: {}, processedMsgIds: [], channels: {} }): StoreHandle {
  return { data, save() {} };
}
