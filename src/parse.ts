import type { RepoSource } from "./jobs.ts";

export type GithubTarget = {
  owner: string;
  name: string;
  issue?: { number: number; url: string };
};

export type FoundTarget = GithubTarget & { source: RepoSource };

const SEG = String.raw`[A-Za-z0-9_.-]+`;
const ITEM_URL = new RegExp(String.raw`github\.com/(${SEG})/(${SEG})/(issues|pull)/(\d+)`);
const SHORT_REF = new RegExp(String.raw`(?:^|[\s(<|])(${SEG})/(${SEG})#(\d+)\b`);
const REPO_URL = new RegExp(String.raw`github\.com/(${SEG})/(${SEG})`);

function cleanRepo(name: string): string {
  return name.replace(/\.+$/, "").replace(/\.git$/, "");
}

function parseOne(text: string): GithubTarget | undefined {
  const item = ITEM_URL.exec(text);
  if (item) {
    const [, owner, rawName, kind, num] = item;
    const name = cleanRepo(rawName);
    return {
      owner,
      name,
      issue: { number: Number(num), url: `https://github.com/${owner}/${name}/${kind}/${num}` },
    };
  }
  const short = SHORT_REF.exec(text);
  if (short) {
    const [, owner, rawName, num] = short;
    const name = cleanRepo(rawName);
    return { owner, name, issue: { number: Number(num), url: `https://github.com/${owner}/${name}/issues/${num}` } };
  }
  const repo = REPO_URL.exec(text);
  if (repo) return { owner: repo[1], name: cleanRepo(repo[2]) };
  return undefined;
}

/** Texts in priority order: the first one that names a target wins. */
export function parseTarget(texts: readonly string[]): GithubTarget | undefined {
  for (const text of texts) {
    const target = parseOne(text);
    if (target) return target;
  }
  return undefined;
}

export type KnownRepo = { owner: string; name: string; displayName?: string };

function norm(text: string): string {
  return text.toLowerCase().replaceAll("_", "-");
}

/** Bare repo names ("fyso-backend") resolved against repos Orca already has; `-` and `_` count as equal. */
export function matchKnownRepo(texts: readonly string[], repos: readonly KnownRepo[]): GithubTarget | undefined {
  for (const text of texts) {
    const words = new Set(norm(text).split(/[^a-z0-9_.-]+/).filter(Boolean));
    const repo = repos.find((r) => words.has(norm(r.name)) || (r.displayName !== undefined && words.has(norm(r.displayName))));
    if (repo) return { owner: repo.owner, name: repo.name };
  }
  return undefined;
}

/** A link or `owner/repo#n` first, then an exact known repo name. Claude's guess is the caller's last resort. */
export function findTarget(texts: readonly string[], repos: readonly KnownRepo[]): FoundTarget | undefined {
  const linked = parseTarget(texts);
  if (linked) return { ...linked, source: "link" };
  const named = matchKnownRepo(texts, repos);
  if (named) return { ...named, source: "name" };
  return undefined;
}

const NEW_TASK = /^\s*(?:nuevo|nueva|!new)(?![\p{L}\p{N}_])[\s:,.-]*/iu;

/** The request without its leading `nuevo`/`nueva`/`!new`, or undefined when the mention is not a separate task. */
export function newTaskRequest(text: string): string | undefined {
  const match = NEW_TASK.exec(text);
  return match ? text.slice(match[0].length).trim() : undefined;
}

type SlackMessageLike = {
  text?: string;
  attachments?: ReadonlyArray<Record<string, unknown>>;
  blocks?: unknown;
};

function collectStrings(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && (key === "text" || key === "url")) out.push(value);
      else collectStrings(value, out);
    }
  }
}

/** Every human-visible string of a Slack message where a GitHub link can hide (unfurls, blocks). */
export function messageTexts(msg: SlackMessageLike): string[] {
  const out: string[] = [];
  if (msg.text) out.push(msg.text);
  for (const att of msg.attachments ?? []) {
    for (const key of ["title_link", "from_url", "original_url", "title", "text", "fallback"]) {
      const value = att[key];
      if (typeof value === "string") out.push(value);
    }
  }
  collectStrings(msg.blocks, out);
  return out;
}

export function stripMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").trim();
}
