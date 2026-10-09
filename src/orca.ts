import { spawn } from "node:child_process";
import type { InboxMessage } from "./jobs.ts";
import type { KnownRepo } from "./parse.ts";

export class OrcaError extends Error {
  readonly code: string;
  readonly result: unknown;
  constructor(code: string, message: string, result?: unknown) {
    super(`orca ${code}: ${message}`);
    this.code = code;
    this.result = result;
  }
}

type Json = Record<string, any>;

function exec(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs `orca <args> --json`. Failed commands still print JSON on stdout, so parse before looking at the exit code. */
export async function orca(args: string[]): Promise<Json> {
  const { code, stdout, stderr } = await exec("orca", [...args, "--json"]);
  let parsed: Json;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OrcaError("bad_output", `exit ${code}: ${(stderr || stdout).trim().slice(-500)}`);
  }
  if (!parsed.ok) {
    throw new OrcaError(parsed.error?.code ?? "unknown", parsed.error?.message ?? "orca failed", parsed.result);
  }
  return parsed.result ?? {};
}

export async function ensureRun(runId: string | undefined): Promise<string> {
  if (runId) {
    try {
      await orca(["orchestration", "run-use", "--id", runId]);
      return runId;
    } catch (err) {
      console.error(`run-use ${runId} failed, creating a new Run:`, (err as Error).message);
    }
  }
  const result = await orca(["orchestration", "run-create", "--objective", "Slack bot: issues de GitHub a PRs"]);
  const id = result.run?.id ?? result.runId ?? result.id;
  if (typeof id !== "string") throw new OrcaError("bad_output", `run-create returned no run id: ${JSON.stringify(result)}`);
  return id;
}

export type WorkerStart = { taskId: string; dispatchId: string; worktreeId?: string };

function workerStart(result: Json): WorkerStart {
  const worktree = (result.effects ?? []).find((e: Json) => e.kind === "worktree");
  return { taskId: result.taskId, dispatchId: result.dispatchId, worktreeId: worktree?.id };
}

const WORKER_COMMON = ["--agent", "claude", "--timeout-ms", "600000"];

export async function startWorker(opts: { repoId: string; name: string; title: string; spec: string }): Promise<WorkerStart> {
  const result = await orca([
    "orchestration", "worker-start",
    "--spec", opts.spec,
    "--task-title", opts.title,
    "--worktree", "new-top-level",
    "--repo", `id:${opts.repoId}`,
    "--name", opts.name,
    "--setup", "run",
    ...WORKER_COMMON,
  ]);
  return workerStart(result);
}

export async function startFollowUp(opts: { worktreeId: string; title: string; spec: string }): Promise<WorkerStart> {
  const result = await orca([
    "orchestration", "worker-start",
    "--spec", opts.spec,
    "--task-title", opts.title,
    "--worktree", `id:${opts.worktreeId}`,
    ...WORKER_COMMON,
  ]);
  return { ...workerStart(result), worktreeId: opts.worktreeId };
}

/** A visible terminal in an existing worktree running `command`; returns its handle. */
export async function createTerminal(opts: { worktreeId: string; title: string; command: string }): Promise<string> {
  const result = await orca(["terminal", "create", "--worktree", `id:${opts.worktreeId}`, "--title", opts.title, "--command", opts.command]);
  const handle = result.terminal?.handle;
  if (typeof handle !== "string") throw new OrcaError("bad_output", `terminal create returned no handle: ${JSON.stringify(result)}`);
  return handle;
}

/** True once the terminal's TUI is idle; false when the wait times out or fails. */
export async function waitTuiIdle(handle: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await orca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", String(timeoutMs)]);
    if (result.wait?.satisfied === true) return true;
    console.error(`terminal wait ${handle} not satisfied: ${JSON.stringify(result)}`);
    return false;
  } catch (err) {
    console.error(`terminal wait ${handle} failed:`, (err as Error).message);
    return false;
  }
}

export async function closeTerminal(handle: string): Promise<void> {
  await orca(["terminal", "close", "--terminal", handle]);
}

/** Hands a task to an agent already running in `handle`; Orca rejects --agent and creation flags here. */
export async function startWorkerInTerminal(opts: { worktreeId: string; handle: string; title: string; spec: string }): Promise<WorkerStart> {
  const result = await orca([
    "orchestration", "worker-start",
    "--spec", opts.spec,
    "--task-title", opts.title,
    "--worktree", `id:${opts.worktreeId}`,
    "--terminal", opts.handle,
    "--timeout-ms", "600000",
  ]);
  return { ...workerStart(result), worktreeId: opts.worktreeId };
}

/** Succeeds only when Orca's receipt says the dispatch is stopped; a repeat stop reports `stopped` with `alreadySettled`. */
export async function stopWorker(dispatchId: string): Promise<void> {
  const result = await orca(["orchestration", "worker-stop", "--dispatch", dispatchId]);
  if (result.state !== "stopped") throw new OrcaError("not_stopped", `worker-stop left ${dispatchId} in state ${result.state}`, result);
}

export type Delivery = { deliveryId?: string; messages: InboxMessage[]; timedOut: boolean };

export async function checkInbox(ackDeliveryId?: string, timeoutMs = 60_000): Promise<Delivery> {
  const args = ["orchestration", "check", "--wait", "--types", "worker_done,escalation,question,status", "--timeout-ms", String(timeoutMs)];
  if (ackDeliveryId) args.push("--ack", ackDeliveryId);
  const result = await orca(args);
  return { deliveryId: result.deliveryId ?? undefined, messages: result.messages ?? [], timedOut: Boolean(result.timedOut) };
}

export async function reply(questionMsgId: string, body: string): Promise<void> {
  await orca(["orchestration", "reply", "--id", questionMsgId, "--body", body]);
}

export async function send(dispatchId: string, body: string): Promise<void> {
  await orca(["orchestration", "send", "--to", `dispatch:${dispatchId}`, "--subject", "Follow-up", "--body", body]);
}

export async function release(dispatchId: string): Promise<void> {
  await orca(["orchestration", "worker-release", "--dispatch", dispatchId]);
}

async function githubRepoId(owner: string, name: string): Promise<string | undefined> {
  const { projects = [] } = await orca(["project", "list"]);
  const project = projects.find(
    (p: Json) =>
      p.providerIdentity?.provider === "github" &&
      String(p.providerIdentity.owner).toLowerCase() === owner.toLowerCase() &&
      String(p.providerIdentity.repo).toLowerCase() === name.toLowerCase(),
  );
  return project?.sourceRepoIds?.[0];
}

export async function knownGithubRepos(): Promise<KnownRepo[]> {
  const { projects = [] } = await orca(["project", "list"]);
  return projects
    .filter((p: Json) => p.providerIdentity?.provider === "github")
    .map((p: Json) => ({ owner: String(p.providerIdentity.owner), name: String(p.providerIdentity.repo), displayName: p.displayName }));
}

export async function findRepo(owner: string, name: string): Promise<string> {
  const known = await githubRepoId(owner, name);
  if (known) return known;
  await orca([
    "project", "setup-clone",
    "--project", `github:${owner}/${name}`,
    "--host", "local",
    "--url", `https://github.com/${owner}/${name}.git`,
    "--destination", "/home/facu/orca/projects",
  ]);
  const cloned = await githubRepoId(owner, name);
  if (!cloned) throw new OrcaError("repo_not_found", `cloned ${owner}/${name} but Orca lists no repo for it`);
  return cloned;
}

export async function repoIdForPath(path: string): Promise<string> {
  const { repos = [] } = await orca(["repo", "list"]);
  const repo = repos.find((r: Json) => r.path === path);
  if (!repo) throw new OrcaError("repo_not_found", `no Orca repo at ${path}; run: orca repo add --path ${path}`);
  return repo.id;
}

export function worktreePath(worktreeId: string): string {
  return worktreeId.slice(worktreeId.indexOf("::") + 2);
}

export async function currentBranch(worktreeId: string): Promise<string | undefined> {
  const branch = await exec("git", ["-C", worktreePath(worktreeId), "branch", "--show-current"]);
  const head = branch.stdout.trim();
  return branch.code === 0 && head ? head : undefined;
}

/** Fallback when worker_done omits the PR line: look the PR up by the worktree's branch. */
export async function lookupPrUrl(worktreeId: string, owner: string, name: string): Promise<string | undefined> {
  const head = await currentBranch(worktreeId);
  if (!head) return undefined;
  const pr = await exec("gh", ["pr", "list", "--repo", `${owner}/${name}`, "--head", head, "--state", "all", "--json", "url", "--limit", "1"]);
  if (pr.code !== 0) return undefined;
  try {
    return (JSON.parse(pr.stdout) as { url: string }[])[0]?.url;
  } catch {
    return undefined;
  }
}

export type Orca = {
  startWorker: typeof startWorker;
  startFollowUp: typeof startFollowUp;
  createTerminal: typeof createTerminal;
  waitTuiIdle: typeof waitTuiIdle;
  closeTerminal: typeof closeTerminal;
  startWorkerInTerminal: typeof startWorkerInTerminal;
  stopWorker: typeof stopWorker;
  checkInbox: typeof checkInbox;
  reply: typeof reply;
  send: typeof send;
  release: typeof release;
  lookupPrUrl: typeof lookupPrUrl;
  currentBranch: typeof currentBranch;
};

export const realOrca: Orca = {
  startWorker,
  startFollowUp,
  createTerminal,
  waitTuiIdle,
  closeTerminal,
  startWorkerInTerminal,
  stopWorker,
  checkInbox,
  reply,
  send,
  release,
  lookupPrUrl,
  currentBranch,
};
