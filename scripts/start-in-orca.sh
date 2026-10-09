#!/usr/bin/env bash
# The bot must live inside an Orca terminal: run-create/run-use bind the calling terminal as coordinator.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$dir/.env" ] || { echo "falta $dir/.env (copiá .env.example)" >&2; exit 1; }

# Orca terminal titles are overwritten by the shell prompt, so the running bot is found by its process, not its tab.
running_bot() {
  local p args
  for p in /proc/[0-9]*; do
    [ "$(readlink "$p/cwd" 2>/dev/null)" = "$dir" ] || continue
    mapfile -d '' args < "$p/cmdline" 2>/dev/null || continue
    if [ "${#args[@]}" -eq 3 ] && [ "$(basename "${args[0]}")" = node ] && [ "${args[1]}" = --env-file=.env ] && [ "${args[2]}" = src/main.ts ]; then
      echo "${p#/proc/}"
      return 0
    fi
  done
  return 1
}

handle_file="$dir/data/bot-terminal"

if pid="$(running_bot)"; then
  if [ "${1:-}" != --restart ]; then
    echo "el bot ya está corriendo en $dir (pid $pid); no arranco otro (usá --restart)" >&2
    exit 1
  fi
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fi
# The old bot's terminal stays open at a shell prompt after the process ends; close it so restarts don't pile up terminals.
if [ -f "$handle_file" ]; then
  orca terminal close --terminal "$(cat "$handle_file")" --json >/dev/null 2>&1 || true
  rm -f "$handle_file"
fi
mkdir -p "$dir/data"
orca terminal create --worktree "path:$dir" --title slack-bot --command "node --env-file=.env src/main.ts" --json |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0)); const h=j.result?.terminal?.handle; if(!h){console.error(JSON.stringify(j));process.exit(1)} require("fs").writeFileSync(process.argv[1], h); console.log(`bot arrancado en la terminal ${h}`)' "$handle_file"
