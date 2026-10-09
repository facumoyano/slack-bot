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
  };
  const orca: Orca = {
    async startWorker(o) {
      calls.push(`start ${o.name}`);
      return { taskId: "t1", dispatchId: "d1", worktreeId: "r1::/wt/api" };
    },
    async startFollowUp(o) {
      calls.push(`followup ${o.worktreeId}`);
      specs.push(o.spec);
      return { taskId: "t2", dispatchId: "d2", worktreeId: o.worktreeId };
    },
    async createTerminal(o) {
      calls.push(`terminal ${o.worktreeId} ${o.command}`);
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
      return { taskId: "t3", dispatchId: "d3", worktreeId: o.worktreeId };
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
    knownRepos: async () => [
      { owner: "acme", name: "api" },
      { owner: "acme", name: "web" },
    ],
    async latestSession(path) {
      return sessions[path];
    },
    async ask(o) {
      calls.push(`ask ${o.repoPath} ${o.question}`);
      return "## Respuesta\nSe valida en **src/webhook.ts:12**.";
    },
  };
  return { posts, messages, updates, ephemerals, reactions, calls, specs, store, deps, sessions, clock };
}

export function workingJob(): Job {
  const job = newJob({
    slack: { channel: "C1", threadTs: "100.1", requester: "U1" },
    repo: { owner: "acme", name: "api", orcaRepoId: "r1" },
    issue: { number: 5, url: "https://github.com/acme/api/issues/5" },
    request: "arreglalo",
  });
  return transition(job, { kind: "started", worktreeId: "r1::/wt/api", taskId: "t1", dispatchId: "d1" })!;
}
