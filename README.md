# slack-bot

Bot de Slack que trabaja como un programador más. Lo mencionás en el hilo de un issue de GitHub, un worker de Claude Code lo resuelve en esta VPS a través de Orca, abre el PR y el bot deja el link en el hilo.

## Setup

1. Creá la app en <https://api.slack.com/apps> con **From an app manifest** y pegá `slack-manifest.yaml`. Instalala en el workspace.
2. Tokens:
   - `SLACK_BOT_TOKEN` (`xoxb-…`): OAuth & Permissions → Bot User OAuth Token.
   - `SLACK_APP_TOKEN` (`xapp-…`): Basic Information → App-Level Tokens, con scope `connections:write`.
3. `cp .env.example .env` y completá los tokens y `ALLOWED_SLACK_USERS` (IDs separados por coma). Si alguien no autorizado menciona al bot, la respuesta le muestra su ID para que lo agregues.
4. `npm install`.
5. `gh auth setup-git` para que los workers puedan hacer `git push` con la sesión de `gh`.
6. Invitá al bot a los canales (`/invite @devbot`).
7. `scripts/start-in-orca.sh`. Abre una terminal de Orca llamada `slack-bot` que corre `node --env-file=.env src/main.ts`. Tiene que correr dentro de Orca porque la Run de orquestación se ata a la terminal que la crea.

## Uso

- En el hilo de un mensaje con un issue (`https://github.com/org/repo/issues/12` o `org/repo#12`): `@devbot arreglalo`. Si el link está en tu mensaje, gana sobre el del mensaje raíz.
- Si el worker tiene una duda, el bot la publica en el hilo mencionándote. Respondé en el hilo sin mencionar al bot.
- Mientras trabaja, cualquier mensaje tuyo en el hilo le llega como indicación extra.
- Cuando terminó, mencionalo de nuevo en el mismo hilo para pedir cambios. Sigue sobre el mismo worktree y la misma rama.

Para probar sin Slack:

```sh
node scripts/simulate.ts "arreglá https://github.com/org/repo/issues/12"
node scripts/simulate.ts --repo-path /ruta/a/repo/registrado/en/orca "Agregá un HELLO.md"
```

Imprime lo que el bot publicaría y lee las respuestas a las preguntas por stdin.

## Cómo funciona

Un solo proceso Node. Al arrancar retoma la Run guardada con `orca orchestration run-use` (o crea una nueva) y persiste todo en `data/state.json`. Cada mención crea un Job por hilo, busca el repo en Orca (lo clona si no está) y lanza `orca orchestration worker-start` con una spec que obliga a leer el issue, commitear, pushear, abrir el PR y cerrar con `worker_done` incluyendo `PR: <url>`. Un loop hace `orca orchestration check --wait`, rutea cada mensaje al Job por `dispatchId`, publica en Slack, marca el mensaje como procesado y recién después hace ack del lote, así un reinicio no pierde ni duplica avisos. Las transiciones están todas en `src/jobs.ts`.

```
            mención
               │
           starting ──(falla al arrancar)──▶ failed
               │ worker-start ok
               ▼
            working ◀──── respuesta en el hilo ────┐
               │  question                         │
               ├──────────▶ awaiting_answer ───────┘
               │ worker_done
               ▼
             done (✅ succeeded / ❌ failed, con link al PR)
               │ nueva mención en el hilo
               └──▶ starting (follow-up en el mismo worktree)
```

## Tests

`npm test`
