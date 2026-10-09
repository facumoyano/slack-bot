import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude keeps each session at `~/.claude/projects/<cwd with every non-alphanumeric char as "-">/<sessionId>.jsonl`. */
export function claudeProjectDir(cwd: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

// The id is typed into a shell as `claude --resume <id>`, so anything but a plain id is refused.
const SESSION_ID = /^[A-Za-z0-9-]+$/;

/** The most recently written session in a Claude project dir; a resumed session may have started a new file. */
export async function newestSession(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let newest: { id: string; mtime: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(0, -".jsonl".length);
    if (!SESSION_ID.test(id)) continue;
    const { mtimeMs } = await stat(join(dir, entry.name));
    if (!newest || mtimeMs > newest.mtime) newest = { id, mtime: mtimeMs };
  }
  return newest?.id;
}

export function latestSession(worktreePath: string): Promise<string | undefined> {
  return newestSession(claudeProjectDir(worktreePath));
}
