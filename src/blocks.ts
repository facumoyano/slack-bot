import type { types } from "@slack/bolt";
import type { RepoRef } from "./jobs.ts";
import { ASKABLE, BUTTON_LABELS } from "./route.ts";
import type { AskableRoute } from "./route.ts";

export type Block = types.KnownBlock;

/** Every message keeps `text` as the fallback for notifications; `blocks` add the buttons. */
export type Message = { text: string; blocks?: Block[] };

/** Every interactive element's action_id starts with this, so one Bolt handler sees them all. */
export const ACTION_PREFIX = "alfred_";

export const ACTIONS = {
  /** One per option; Slack rejects duplicate action_ids in a block, so the option index is appended. */
  answer: `${ACTION_PREFIX}answer`,
  stop: `${ACTION_PREFIX}stop`,
  repo: `${ACTION_PREFIX}repo`,
  /** One per route, suffixed with the route's name. */
  route: `${ACTION_PREFIX}route`,
  /** A URL button: Slack opens the link itself but still sends the click, which must be acked. */
  pr: `${ACTION_PREFIX}pr`,
} as const;

export const MAX_OPTION_BUTTONS = 5;

export type Click =
  | { kind: "answer"; jobId: string; questionMsgId: string; option: number }
  | { kind: "stop"; jobId: string }
  | { kind: "repo"; jobId: string; repo: RepoRef }
  | { kind: "route"; jobId: string; route: AskableRoute };

const SECTION_MAX = 3000;
const LABEL_MAX = 75;
const OPTION_VALUE_MAX = 150;

function label(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

/** Text in chunks of at most `max` characters, split on line breaks; only a longer line is split mid-line. */
export function splitText(text: string, max: number): string[] {
  const pieces = text.split("\n").flatMap((line) => line.match(new RegExp(`[^]{1,${max}}`, "g")) ?? [""]);
  const chunks: string[] = [];
  let current: string | undefined;
  for (const piece of pieces) {
    if (current !== undefined && current.length + 1 + piece.length > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current === undefined ? piece : `${current}\n${piece}`;
    }
  }
  if (current !== undefined) chunks.push(current);
  return chunks;
}

/** Text as section blocks, split on line breaks to fit Slack's per-section limit. */
export function textBlocks(text: string): Block[] {
  return splitText(text, SECTION_MAX)
    .filter((chunk) => chunk.trim())
    .map((chunk) => ({ type: "section", text: { type: "mrkdwn", text: chunk } }));
}

export function questionMessage(o: { jobId: string; questionMsgId: string; requester: string; question: string; options: readonly string[] }): Message {
  const head = `<@${o.requester}> pregunta: ${o.question}`;
  const list = o.options.length ? `\nOpciones: ${o.options.join(" / ")}` : "";
  const text = `${head}${list}\n_Respondé en este hilo._`;
  if (!o.options.length || o.options.length > MAX_OPTION_BUTTONS) return { text };
  return {
    text,
    blocks: [
      ...textBlocks(`${head}\n_Elegí una opción o respondé en este hilo._`),
      {
        type: "actions",
        elements: o.options.map((option, i) => ({
          type: "button",
          action_id: `${ACTIONS.answer}_${i}`,
          text: { type: "plain_text", text: label(option) },
          value: JSON.stringify({ j: o.jobId, q: o.questionMsgId, o: i }),
        })),
      },
    ],
  };
}

export function answeredMessage(o: { requester: string; question: string; user: string; answer: string }): Message {
  const text = `<@${o.requester}> pregunta: ${o.question}\n✅ <@${o.user}> respondió: ${o.answer}`;
  return { text, blocks: textBlocks(text) };
}

export function startMessage(o: { jobId: string; text: string; current: RepoRef; repos?: readonly RepoRef[] }): Message {
  const choices = (o.repos ?? [])
    .filter((r) => `${r.owner}/${r.name}`.toLowerCase() !== `${o.current.owner}/${o.current.name}`.toLowerCase())
    .map((r) => ({ repo: `${r.owner}/${r.name}`, value: JSON.stringify({ j: o.jobId, r: `${r.owner}/${r.name}` }) }))
    .filter((c) => c.value.length <= OPTION_VALUE_MAX)
    .slice(0, 100);
  const stop = { type: "button" as const, action_id: ACTIONS.stop, text: { type: "plain_text" as const, text: "⏹️ Parar" }, value: o.jobId };
  const select = {
    type: "static_select" as const,
    action_id: ACTIONS.repo,
    placeholder: { type: "plain_text" as const, text: "Cambiar repo" },
    options: choices.map((c) => ({ text: { type: "plain_text" as const, text: label(c.repo) }, value: c.value })),
  };
  return { text: o.text, blocks: [...textBlocks(o.text), { type: "actions", elements: choices.length ? [stop, select] : [stop] }] };
}

export const ROUTE_QUESTION = "¿Qué querés que haga?";

/** Asked when a plain mention's route is unclear; each button runs that route on the original mention. */
export function routeAskMessage(jobId: string): Message {
  return {
    text: ROUTE_QUESTION,
    blocks: [
      ...textBlocks(ROUTE_QUESTION),
      {
        type: "actions",
        elements: ASKABLE.map((route) => ({
          type: "button" as const,
          action_id: `${ACTIONS.route}_${route}`,
          text: { type: "plain_text" as const, text: BUTTON_LABELS[route] },
          value: jobId,
        })),
      },
    ],
  };
}

/** The same text with its buttons gone. */
export function plainMessage(text: string): Message {
  return { text, blocks: textBlocks(text) };
}

/** Slack keeps a message's text under 40k characters; the sections below split it, so only an outsized plan is cut. */
export const MESSAGE_MAX = 39_000;

/** A plan as its own message, apart from the approval question whose message is rewritten once answered. */
export function planMessage(mrkdwn: string): Message {
  const full = `📋 *Plan*\n\n${mrkdwn}`;
  return plainMessage(full.length > MESSAGE_MAX ? `${full.slice(0, MESSAGE_MAX)}…` : full);
}

export function doneMessage(text: string, prUrl?: string): Message {
  if (!prUrl) return { text };
  return {
    text,
    blocks: [
      ...textBlocks(text),
      { type: "actions", elements: [{ type: "button", action_id: ACTIONS.pr, text: { type: "plain_text", text: "Ver PR" }, url: prUrl }] },
    ],
  };
}

const JOB_ID = /^[A-Za-z0-9]+:\d+\.\d+$/;
const REPO = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

function json(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Validates a click from Slack; anything that is not exactly what the builders above produce is undefined. */
export function parseClick(actionId: string, value: string | undefined): Click | undefined {
  if (value === undefined) return undefined;
  if (actionId === ACTIONS.stop) return JOB_ID.test(value) ? { kind: "stop", jobId: value } : undefined;
  if (actionId === ACTIONS.repo) {
    const v = json(value);
    const repo = typeof v?.r === "string" ? REPO.exec(v.r) : null;
    if (typeof v?.j !== "string" || !JOB_ID.test(v.j) || !repo) return undefined;
    return { kind: "repo", jobId: v.j, repo: { owner: repo[1], name: repo[2] } };
  }
  if (actionId.startsWith(`${ACTIONS.route}_`)) {
    const route = ASKABLE.find((r) => actionId === `${ACTIONS.route}_${r}`);
    return route && JOB_ID.test(value) ? { kind: "route", jobId: value, route } : undefined;
  }
  const index = actionId.startsWith(`${ACTIONS.answer}_`) ? Number(actionId.slice(ACTIONS.answer.length + 1)) : NaN;
  if (Number.isInteger(index)) {
    const v = json(value);
    if (typeof v?.j !== "string" || !JOB_ID.test(v.j) || typeof v.q !== "string" || !v.q || v.o !== index || index < 0 || index >= MAX_OPTION_BUTTONS) {
      return undefined;
    }
    return { kind: "answer", jobId: v.j, questionMsgId: v.q, option: index };
  }
  return undefined;
}
