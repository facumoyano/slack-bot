import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { jobSlug } from "./files.ts";

const REPORT_DIR = join(import.meta.dirname, "..", "data", "reports");

export function reportPath(jobId: string): string {
  return join(REPORT_DIR, `${jobSlug(jobId)}.md`);
}

export async function readReport(jobId: string): Promise<string | undefined> {
  const text = await readFile(reportPath(jobId), "utf8").catch(() => undefined);
  return text?.trim() || undefined;
}

export async function clearReport(jobId: string): Promise<void> {
  await rm(reportPath(jobId), { force: true });
}

function inline(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `*${a ?? b}*`);
}

const MAX_POST = 3500;

/** Agent Markdown as a Slack post, cut to fit one message. */
export function slackPost(markdown: string): string {
  const text = toSlackMrkdwn(markdown);
  return text.length > MAX_POST ? `${text.slice(0, MAX_POST)}…` : text;
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
