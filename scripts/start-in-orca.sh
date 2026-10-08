#!/usr/bin/env bash
# The bot must live inside an Orca terminal: run-create/run-use bind the calling terminal as coordinator.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$dir/.env" ] || { echo "falta $dir/.env (copiá .env.example)" >&2; exit 1; }
orca terminal create --worktree "path:$dir" --title slack-bot --command "node --env-file=.env src/main.ts" --json
