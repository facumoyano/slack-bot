import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MESSAGE_MAX } from "./blocks.ts";
import { jobSlug } from "./files.ts";

const REPORT_DIR = join(import.meta.dirname, "..", "data", "reports");

export function reportPath(jobId: string): string {
  return join(REPORT_DIR, `${jobSlug(jobId)}.md`);
}

export function planPath(jobId: string): string {
  return join(REPORT_DIR, `${jobSlug(jobId)}.plan.md`);
}

/** What a relay worker writes: the thread message with its header, or its private digest for the owner. */
export function relayPath(jobId: string): string {
  return join(REPORT_DIR, `${jobSlug(jobId)}.relay.md`);
}

async function readText(path: string): Promise<string | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text?.trim() || undefined;
}

export function readReport(jobId: string): Promise<string | undefined> {
  return readText(reportPath(jobId));
}

export function readPlan(jobId: string): Promise<string | undefined> {
  return readText(planPath(jobId));
}

export function readRelay(jobId: string): Promise<string | undefined> {
  return readText(relayPath(jobId));
}

/** A new run starts with no report, plan or relay file, so a previous run's files are never posted as this one's. */
export async function clearReports(jobId: string): Promise<void> {
  await Promise.all([reportPath(jobId), planPath(jobId), relayPath(jobId)].map((path) => rm(path, { force: true })));
}

function inline(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `*${a ?? b}*`);
}

/** Agent Markdown as a Slack post; only a report past Slack's message limit is cut. */
export function slackPost(markdown: string): string {
  const text = toSlackMrkdwn(markdown);
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text;
}

/** Markdown as agents write it, rendered with Slack's mrkdwn dialect. Code fences pass through untouched. */
export function toSlackMrkdwn(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) return `*${inline(heading[1]).replace(/^\*(.*)\*$/, "$1")}*`;
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
      return inline(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
