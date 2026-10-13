import { isAbsolute, resolve } from "node:path";
import type { LocalDir } from "./jobs.ts";

export type DirEntry = { channel: string; path: string };

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

/** `ALFRED_DIRS`: comma-separated `channelId=/absolute/path`. A malformed entry is reported, never thrown, so one typo does not stop the bot. */
export function parseDirs(value: string | undefined): { entries: DirEntry[]; problems: string[] } {
  const entries: DirEntry[] = [];
  const problems: string[] = [];
  for (const raw of (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = raw.indexOf("=");
    const channel = eq < 0 ? "" : raw.slice(0, eq).trim();
    const path = eq < 0 ? "" : raw.slice(eq + 1).trim();
    if (!CHANNEL_ID.test(channel) || !path) problems.push(`"${raw}" is not channelId=/path (for example C0123ABC=/home/facu/orca/projects/mkt-fyso)`);
    else if (!isAbsolute(path)) problems.push(`${channel}: "${path}" is not an absolute path`);
    else if (entries.some((e) => e.channel === channel)) problems.push(`${channel} is listed more than once`);
    else entries.push({ channel, path: resolve(path) });
  }
  return { entries, problems };
}

export type DirChecks = {
  isDirectory(path: string): Promise<boolean>;
  /** The Orca repo registered at exactly this path, if any. */
  orcaRepoAt(path: string): Promise<{ id: string; name: string } | undefined>;
};

/** The channels bound to a local directory, by channel id; entries whose folder is missing or not in Orca are left out and reported. */
export async function loadDirs(value: string | undefined, checks: DirChecks): Promise<{ dirs: Record<string, LocalDir>; problems: string[] }> {
  const { entries, problems } = parseDirs(value);
  const dirs: Record<string, LocalDir> = {};
  for (const { channel, path } of entries) {
    if (!(await checks.isDirectory(path))) {
      problems.push(`${channel}: ${path} does not exist or is not a directory`);
      continue;
    }
    const repo = await checks.orcaRepoAt(path);
    if (!repo) {
      problems.push(`${channel}: ${path} is not an Orca repo (orca repo add --path ${path})`);
      continue;
    }
    dirs[channel] = { name: repo.name, path };
  }
  return { dirs, problems };
}
