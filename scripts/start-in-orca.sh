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

if pid="$(running_bot)"; then
  echo "el bot ya está corriendo en $dir (pid $pid); no arranco otro" >&2
  exit 1
fi
orca terminal create --worktree "path:$dir" --title slack-bot --command "node --env-file=.env src/main.ts" --json
