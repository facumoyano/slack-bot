import type { Mention } from "./bot.ts";
import type { AskableRoute } from "./route.ts";

/** What a request runs once approved: a route on its own thread, or `!nuevo`'s change in a new thread. */
export type Work = AskableRoute | "new_thread";

export type ApprovalState =
  | { kind: "pending" }
  | { kind: "approved"; by: string }
  | { kind: "rejected"; by: string }
  | { kind: "expired" };

/**
 * A teammate's request waiting on an owner, kept in the store so a restart keeps its buttons working.
 * Only the owners' DM talks about it: the teammate sees 👀, then the normal start or a neutral refusal.
 */
export type Approval = {
  id: string;
  /** The teammate's mention as it would have run, already resolved; `mention.user` is the requester. */
  mention: Mention;
  work: Work;
  /** How Jev understood a plain mention, for the start message once approved. */
  note?: string;
  /** The repo, issue or PR the run would touch, as the card shows it. */
  target: string;
  /** The run continues this thread's finished job instead of starting a new one. */
  followUp: boolean;
  link?: string;
  createdAt: number;
  /** The card in each owner's DM, rewritten once decided. */
  cards: { channel: string; ts: string }[];
  state: ApprovalState;
};

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function approvalId(m: Pick<Mention, "channel" | "ts">): string {
  return `${m.channel}:${m.ts}`;
}

export type Decision = Exclude<ApprovalState, { kind: "pending" }>;

/** Undefined once decided: the first decision wins. */
export function decide(approval: Approval, decision: Decision): Approval | undefined {
  return approval.state.kind === "pending" ? { ...approval, state: decision } : undefined;
}

export function dueExpiries(approvals: Record<string, Approval>, now: number): Approval[] {
  return Object.values(approvals).filter((a) => a.state.kind === "pending" && now - a.createdAt >= APPROVAL_TTL_MS);
}

export const WORK_TEXT: Record<Work, string> = {
  change: "cambio de código con PR",
  plan: "plan para aprobar en el hilo, y con ese ok, cambio de código con PR",
  investigate: "investigación con reporte, sin PR",
  review: "revisión de PR, sin tocarlo",
  question: "pregunta rápida leyendo el repo, sin worker",
  new_thread: "cambio de código con PR, en un hilo nuevo del canal",
};
