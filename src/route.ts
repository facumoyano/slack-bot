import { lastRun } from "./jobs.ts";
import type { Job, Mode } from "./jobs.ts";

/** What a plain mention (no `!command`) asks for: a worker mode, a quick `!pregunta` answer, or nothing. */
export const ROUTES = ["change", "question", "investigate", "review", "plan", "none"] as const;
export type Route = (typeof ROUTES)[number];

/** The routes a human can pick from the buttons when Jev is unsure. */
export const ASKABLE = ["change", "question", "investigate", "review", "plan"] as const satisfies readonly Route[];
export type AskableRoute = (typeof ASKABLE)[number];

export function isMode(route: Route): route is Mode {
  return route === "change" || route === "investigate" || route === "review" || route === "plan";
}

export type RouteAnswer = { choice: Route; confidence: number; probabilities: Record<string, number> };

/**
 * The confidence each route needs before the bot acts on it alone, per consequence: read-only routes cost a
 * wasted answer when wrong, `change` and `plan` start a worker that writes code, and `none` stays silent.
 * Picked from `scripts/eval-route.ts` over `eval/route-cases.json`.
 */
export const THRESHOLDS: Record<Route, number> = {
  question: 0.5,
  investigate: 0.5,
  review: 0.5,
  change: 0.8,
  plan: 0.8,
  none: 0.8,
};

export type Decision = { kind: "route"; route: Route } | { kind: "ask" };

export function decideRoute(answer: RouteAnswer, thresholds: Record<Route, number> = THRESHOLDS): Decision {
  return answer.confidence >= thresholds[answer.choice] ? { kind: "route", route: answer.choice } : { kind: "ask" };
}

const CONTEXT_MAX = 1500;

/** What Jev sees, as named fields. */
export type RouteState = {
  mention: string;
  thread_job: { mode: Mode; state: Job["state"]["kind"]; pr: string | null } | null;
  mention_has_pr_link: boolean;
  mention_has_issue_link: boolean;
  thread_context: string | null;
};

/** A relay is private, so the router sees the thread's own last run in its place. */
function threadJob(job: Job): NonNullable<RouteState["thread_job"]> {
  const state = lastRun(job) ?? job.state;
  return { mode: job.mode, state: state.kind, pr: state.kind === "done" ? (state.prUrl ?? null) : null };
}

export function routeState(m: { text: string; context?: string }, job: Job | undefined): RouteState {
  return {
    mention: m.text,
    thread_job: job ? threadJob(job) : null,
    mention_has_pr_link: /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(m.text),
    mention_has_issue_link: /github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/.test(m.text),
    thread_context: m.context ? m.context.slice(-CONTEXT_MAX) : null,
  };
}

const CRITERIA: Record<Route, string> = {
  change:
    "Wants the bot to write or modify code in the repository and open or update a pull request: fix a bug, implement or add something, refactor, add tests, apply review feedback, update or merge a branch. Includes requests to check something and then fix it, imperatives like 'arreglalo', 'hacelo', 'agregá', 'cambiá', and a bare GitHub issue link handed to the bot as work. After the bot investigated or planned in this thread, a go-ahead to implement it counts here.",
  question:
    "Asks a quick, specific question about the code that can be answered by reading the repository as it is: what something does, where something lives, how something works, what a file says. Nothing needs to run and nothing changes.",
  investigate:
    "Asks the bot to find out something that needs digging: why something fails or behaves oddly, reproduce a bug, run code or tests, look at logs, git history or a deploy, and come back with a diagnosis backed by evidence, without changing code.",
  review:
    "Asks the bot to review, assess or explain an existing pull request that is already open (is it right, is it ready to merge, what does it change), without modifying it. A pull request link handed to the bot with no other request counts here.",
  plan: "Explicitly asks to see, write or approve a plan before any code is touched ('hacé un plan', 'armá un plan', 'mostrame cómo lo harías antes de tocar nada').",
  none: "Not a request for the bot to do anything: thanks, a greeting, an acknowledgement, a joke, a remark addressed to other people in the thread, or an aside.",
};

const INSTRUCTIONS =
  "A developer mentioned a coding bot in a Slack thread; the mention is usually Spanish (Argentina), sometimes English. `mention` is what they wrote to the bot now, `thread_job` is the bot's earlier work in this thread if any, and `thread_context` holds earlier human messages of the thread. Decide what the developer wants the bot to do with this mention.";

export function routeRequest(state: RouteState): object {
  return { model: "jev-latest", state, questions: { route: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA } } };
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const ROUTE_TIMEOUT_MS = 5_000;

function parseAnswer(body: unknown): RouteAnswer {
  const route = (body as { answers?: { route?: Partial<RouteAnswer> } } | null)?.answers?.route;
  if (!route || !(ROUTES as readonly unknown[]).includes(route.choice) || typeof route.confidence !== "number") {
    throw new Error(`typesafe: unexpected answer ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { choice: route.choice as Route, confidence: route.confidence, probabilities: route.probabilities ?? {} };
}

/** Asks Jev; throws on an HTTP error, a malformed answer or the timeout, and the caller asks the human instead. */
export async function classifyWithJev(apiKey: string, state: RouteState, timeoutMs = ROUTE_TIMEOUT_MS): Promise<RouteAnswer> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(routeRequest(state)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parseAnswer(await res.json());
}

const NAMES: Record<Route, string> = {
  change: "cambio de código",
  question: "pregunta rápida",
  investigate: "investigación",
  review: "revisión",
  plan: "pedido de plan",
  none: "comentario",
};

const COMMAND: Partial<Record<Route, string>> = { question: "!pregunta", investigate: "!investiga", review: "!revisa", plan: "!plan" };

/** Appended to the start message when Jev, not a command, picked the route. */
export function routeHint(route: Route): string {
  const others = Object.entries(COMMAND).filter(([r]) => r !== route).map(([, c]) => `\`${c}\``);
  return `(lo tomé como ${NAMES[route]}; si no era eso, usá ${others.join(", ")}${route === "change" ? "" : " o pedí el cambio explícito"})`;
}

export const BUTTON_LABELS: Record<AskableRoute, string> = {
  change: "Cambio de código",
  question: "Pregunta rápida",
  investigate: "Investigar",
  review: "Revisar PR",
  plan: "Plan",
};
