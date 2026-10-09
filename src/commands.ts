import type { RepoRef } from "./jobs.ts";
import { matchKnownRepo, parseTarget } from "./parse.ts";
import type { KnownRepo } from "./parse.ts";

const COMMANDS = [
  { name: "nuevo", aliases: ["nuevo", "new"], usage: "!nuevo <pedido>", help: "abre una tarea aparte en un hilo nuevo" },
  { name: "pregunta", aliases: ["pregunta", "ask"], usage: "!pregunta <pregunta>", help: "respondo leyendo el repo, sin worktree ni PR" },
  { name: "repo", aliases: ["repo"], usage: "!repo [repo | borrar]", help: "muestra, fija o borra el repo por defecto de este canal" },
  { name: "parar", aliases: ["parar", "cancelar", "stop"], usage: "!parar", help: "freno el trabajo de este hilo; la rama queda para retomarla" },
  { name: "aparte", aliases: ["aparte", "aside"], usage: "!aparte …", help: "ignoro ese mensaje, con o sin mención (para hablar entre ustedes en el hilo)" },
  { name: "ayuda", aliases: ["ayuda", "help"], usage: "!ayuda", help: "esta lista" },
] as const;

export type CommandName = (typeof COMMANDS)[number]["name"];

export type Command = { name: CommandName; rest: string };

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const BY_ALIAS = new Map<string, CommandName>(COMMANDS.flatMap((c) => c.aliases.map((a) => [a, c.name] as const)));

const HEAD = /^\s*!([^\s:]+)[\s:]*/u;

/** A command is only a known `!word` as the first token, followed by whitespace, `:` or the end; accents and case are ignored. */
export function parseCommand(text: string): Command | undefined {
  const match = HEAD.exec(text);
  const name = match && BY_ALIAS.get(fold(match[1]));
  return name ? { name, rest: text.slice(match[0].length).trim() } : undefined;
}

export function helpText(): string {
  const lines = COMMANDS.map((c) => `• \`${c.usage}\`${c.aliases.length > 1 ? ` (${c.aliases.slice(1).map((a) => `\`!${a}\``).join(", ")})` : ""}: ${c.help}`);
  return ["Comandos, al principio de la mención:", ...lines, "Sin comando, te tomo el pedido como tarea en este hilo.", "Podés adjuntar imágenes o archivos al pedido o en el hilo; los que genere el worker los subo acá."].join("\n");
}

export type RepoArg = { kind: "show" } | { kind: "clear" } | { kind: "set"; repo: RepoRef } | { kind: "unknown"; text: string };

const BARE_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** The `!repo` argument. Only a deterministic repo counts: a GitHub link, `owner/name`, or the exact name of a repo Orca knows. */
export function parseRepoArg(text: string, repos: readonly KnownRepo[]): RepoArg {
  const arg = text.trim();
  if (!arg) return { kind: "show" };
  if (["borrar", "clear"].includes(fold(arg))) return { kind: "clear" };
  const bare = BARE_REPO.exec(arg);
  const found = parseTarget([arg]) ?? (bare ? { owner: bare[1], name: bare[2] } : undefined) ?? matchKnownRepo([arg], repos);
  if (!found) return { kind: "unknown", text: arg };
  const known = repos.find((r) => r.owner.toLowerCase() === found.owner.toLowerCase() && r.name.toLowerCase() === found.name.toLowerCase());
  return { kind: "set", repo: known ? { owner: known.owner, name: known.name } : { owner: found.owner, name: found.name } };
}
