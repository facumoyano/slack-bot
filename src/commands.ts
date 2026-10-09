const COMMANDS = [
  { name: "nuevo", aliases: ["nuevo", "new"], usage: "!nuevo <pedido>", help: "abre una tarea aparte en un hilo nuevo" },
  { name: "pregunta", aliases: ["pregunta", "ask"], usage: "!pregunta <pregunta>", help: "respondo leyendo el repo, sin worktree ni PR" },
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
  return ["Comandos, al principio de la mención:", ...lines, "Sin comando, te tomo el pedido como tarea en este hilo."].join("\n");
}
