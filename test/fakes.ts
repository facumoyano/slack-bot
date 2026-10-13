import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newJob, transition } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import type { Block } from "../src/blocks.ts";
import type { BotDeps, Poster } from "../src/bot.ts";
import type { InboxDeps } from "../src/inbox.ts";
import type { Orca } from "../src/orca.ts";
import { memoryStore } from "../src/store.ts";

export function fakes(over: Partial<Orca> = {}) {
  const posts: string[] = [];
  const specs: string[] = [];
  const reactions: string[] = [];
  const calls: string[] = [];
  const messages: { ts: string; text: string; blocks?: Block[] }[] = [];
  const updates: { ts: string; text: string; blocks?: Block[] }[] = [];
  const ephemerals: string[] = [];
  const dms: { user: string; channel: string; ts: string; text: string; blocks?: Block[] }[] = [];
  const uploads: string[] = [];
  const failUploads = new Set<string>();
  /** Bytes served for each Slack file URL; a missing URL is a 404. */
  const slackFiles: Record<string, Response | (() => Response)> = {};
  const fetched: string[] = [];
  const poster: Poster = {
    async postToThread(_job, text, blocks) {
      posts.push(text);
      const ts = `900.${messages.length + 1}`;
      messages.push({ ts, text, blocks });
      return ts;
    },
    async update(_c, ts, text, blocks) {
      updates.push({ ts, text, blocks });
    },
    async ephemeral(_job, user, text) {
      ephemerals.push(`${user}: ${text}`);
    },
    async react(_c, ts, name) {
      reactions.push(`${ts}:${name}`);
    },
    async postTopLevel(_c, text) {
      posts.push(`[top] ${text}`);
      return "200.1";
    },
    async uploadFile(_job, path) {
      if (failUploads.has(path)) throw new Error("upload_failed");
      uploads.push(path);
    },
    async permalink(channel, ts) {
      return `https://slack.test/${channel}/${ts}`;
    },
    async dm(user, text, blocks) {
      const sent = { user, channel: `D-${user}`, ts: `700.${dms.length + 1}`, text, blocks };
      dms.push(sent);
      return { channel: sent.channel, ts: sent.ts };
    },
  };
  const orca: Orca = {
    async startWorker(o) {
      calls.push(`start ${o.name}`);
      specs.push(o.spec);
      return { taskId: "t1", dispatchId: "d1", worktreeId: "r1::/wt/api" };
    },
    async startFollowUp(o) {
      calls.push(`followup ${o.worktree}`);
      specs.push(o.spec);
      return { taskId: "t2", dispatchId: "d2" };
    },
    async createTerminal(o) {
      calls.push(`terminal ${o.worktree} ${o.command}`);
      return "term-1";
    },
    async waitTuiIdle(handle) {
      calls.push(`wait ${handle}`);
      return true;
    },
    async closeTerminal(handle) {
      calls.push(`close ${handle}`);
    },
    async startWorkerInTerminal(o) {
      calls.push(`resume ${o.handle}`);
      specs.push(o.spec);
      return { taskId: "t3", dispatchId: "d3" };
    },
    async stopWorker(id) {
      calls.push(`stop ${id}`);
    },
    async checkInbox() {
      return { messages: [], timedOut: true };
    },
    async reply(id, body) {
      calls.push(`reply ${id} ${body}`);
    },
    async send(id, body) {
      calls.push(`send ${id} ${body}`);
    },
    async release(id) {
      calls.push(`release ${id}`);
    },
    async lookupPrUrl() {
      calls.push("lookup");
      return "https://github.com/acme/api/pull/99";
    },
    async currentBranch() {
      return "api-issue-5";
    },
    async repoPath(id) {
      calls.push(`repo-path ${id}`);
      return "/repos/api";
    },
  };
  const store = memoryStore();
  const sessions: Record<string, string> = { "/wt/api": "sess-1" };
  const clock = { now: 1_000_000 };
  const deps: BotDeps & InboxDeps = {
    now: () => clock.now,
    orca: { ...orca, ...over },
    poster,
    store,
    resolveRepo: async () => "r1",
    allowedUsers: new Set(["U1", "U2"]),
    approvalUsers: new Set(["T1", "T2"]),
    knownRepos: async () => [
      { owner: "acme", name: "api" },
      { owner: "acme", name: "web" },
    ],
    async latestSession(path) {
      return sessions[path];
    },
    filesRoot: mkdtempSync(join(tmpdir(), "slack-bot-files-")),
    async fetchFile(url) {
      fetched.push(url);
      const served = slackFiles[url];
      return typeof served === "function" ? served() : (served ?? new Response("not found", { status: 404 }));
    },
    async ask(o) {
      calls.push(`ask ${o.repoPath} ${o.question}${o.files?.length ? ` files=${o.files.map((f) => f.path).join(",")}` : ""}`);
      return "## Respuesta\nSe valida en **src/webhook.ts:12**.";
    },
  };
  return { posts, messages, updates, ephemerals, dms, reactions, calls, specs, store, deps, sessions, clock, uploads, failUploads, slackFiles, fetched };
}

export function workingJob(): Job {
  const job = newJob({
    slack: { channel: "C1", threadTs: "100.1", requester: "U1" },
    repo: { owner: "acme", name: "api", orcaRepoId: "r1" },
    issue: { number: 5, url: "https://github.com/acme/api/issues/5" },
    request: "arreglalo",
    mode: "change",
  });
  return transition(job, { kind: "started", worktreeId: "r1::/wt/api", taskId: "t1", dispatchId: "d1" })!;
}
