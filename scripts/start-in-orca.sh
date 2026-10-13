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
log_file="$dir/data/bot.log"

if pid="$(running_bot)"; then
  if [ "${1:-}" != --restart ]; then
    echo "el bot ya está corriendo en $dir (pid $pid); no arranco otro (usá --restart)" >&2
    exit 1
  fi
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fi
# A terminal left by an older start (before the bot ran detached) is closed so restarts don't pile up terminals.
if [ -f "$handle_file" ]; then
  orca terminal close --terminal "$(cat "$handle_file")" --json >/dev/null 2>&1 || true
  rm -f "$handle_file"
fi
mkdir -p "$dir/data"
# Orca only binds the coordinator Run from a live terminal, so the bot starts in one, detaches from it, and the
# terminal is closed once the bot is connected; Orca keeps serving the detached process after that.
start_line=$(( $( { wc -l < "$log_file"; } 2>/dev/null || echo 0) + 1 ))
handle=$(orca terminal create --worktree "path:$dir" --title slack-bot \
  --command "setsid nohup node --env-file=.env src/main.ts >> data/bot.log 2>&1 < /dev/null & disown" --json |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0)); const h=j.result?.terminal?.handle; if(!h){console.error(JSON.stringify(j));process.exit(1)} console.log(h)')
for _ in $(seq 1 120); do
  if tail -n +"$start_line" "$log_file" 2>/dev/null | grep -q "slack: connected"; then
    orca terminal close --terminal "$handle" --json >/dev/null 2>&1 || true
    echo "bot arrancado en segundo plano (pid $(running_bot)); logs en data/bot.log"
    exit 0
  fi
  sleep 0.5
done
echo "el bot no se conectó en 60 s; dejo abierta su terminal $handle para ver qué pasó. Últimas líneas de data/bot.log:" >&2
tail -n +"$start_line" "$log_file" >&2 2>/dev/null || true
exit 1
