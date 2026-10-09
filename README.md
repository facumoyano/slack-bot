# slack-bot

Bot de Slack que trabaja como un programador más. Lo mencionás en el hilo de un issue de GitHub, un worker de Claude Code lo resuelve en esta VPS a través de Orca, abre el PR y el bot deja el link en el hilo.

## Setup

1. Creá la app en <https://api.slack.com/apps> con **From an app manifest** y pegá `slack-manifest.yaml`. Instalala en el workspace. Los botones necesitan **Interactivity & Shortcuts → Interactivity** activado; con Socket Mode no hace falta Request URL.
2. Tokens:
   - `SLACK_BOT_TOKEN` (`xoxb-…`): OAuth & Permissions → Bot User OAuth Token.
   - `SLACK_APP_TOKEN` (`xapp-…`): Basic Information → App-Level Tokens, con scope `connections:write`.
3. `cp .env.example .env` y completá los tokens y `ALLOWED_SLACK_USERS` (IDs separados por coma). Si alguien no autorizado menciona al bot, la respuesta le muestra su ID para que lo agregues.
4. `npm install`.
5. `gh auth setup-git` para que los workers puedan hacer `git push` con la sesión de `gh`.
6. Invitá al bot a los canales (`/invite @alfred`).
7. `scripts/start-in-orca.sh`. Abre una terminal de Orca llamada `slack-bot` que corre `node --env-file=.env src/main.ts`. Tiene que correr dentro de Orca porque la Run de orquestación se ata a la terminal que la crea. Si ya hay un bot corriendo desde este directorio, muestra su pid y no arranca otro.

## Uso

- En el hilo de un mensaje con un issue (`https://github.com/org/repo/issues/12` o `org/repo#12`): `@alfred arreglalo`. El repo sale, en este orden, de tu mensaje (link, después nombre de un repo conocido), del hilo (link, después nombre), del repo del canal (`!repo`) y, si nada de eso, lo deduce Claude del hilo y avisa que lo dedujo.
- El mensaje `🫡 tomo …` trae un botón **⏹️ Parar** (lo mismo que `!parar`). Si el repo lo dedujo o es el del canal, trae también **Cambiar repo**: elegir otro frena el worker y rehace el pedido en ese repo. Los botones desaparecen cuando el trabajo termina.
- Un hilo es una tarea. Si el worker tiene una duda, el bot la publica en el hilo mencionándote. Respondé en el hilo sin mencionar al bot, o tocá una de las opciones si vino con hasta 5. Al responder, el mensaje muestra quién respondió qué y los botones se van.
- El reporte final trae un botón **Ver PR** si hay PR.
- Solo los usuarios de `ALLOWED_SLACK_USERS` pueden tocar botones; a los demás el bot les contesta en privado y no cambia nada. Un botón viejo (de una pregunta ya respondida o un trabajo ya terminado) contesta en privado que ya no es válido.
- Mientras trabaja, cualquier mensaje tuyo en el hilo le llega como indicación extra. Avisa en el hilo con ⏳ cada hito (bug reproducido, causa encontrada, tests pasando, PR abierto), como mucho uno por minuto.
- Cuando terminó, mencionalo de nuevo en el mismo hilo para pedir cambios. Retoma la misma sesión de Claude sobre el mismo worktree y la misma rama.
- Para otra tarea desde un hilo que ya tiene una, usá `!nuevo`: el bot la sigue en un hilo nuevo del canal.

Comandos. Van como primera palabra después de la mención, sin importar mayúsculas ni tildes. Una palabra sin `!` es texto común.

- `!nuevo <pedido>` (`!new`): tarea aparte, en un hilo nuevo.
- `!pregunta <pregunta>` (`!ask`): responde leyendo el repo en solo lectura, sin worktree ni PR, citando `archivo:línea` y la rama y el commit que leyó.
- `!repo <repo>`: fija el repo por defecto del canal (link de GitHub, `owner/nombre` o nombre exacto de un repo de Orca). `!repo` solo muestra el actual y los repos conocidos; `!repo borrar` (`!repo clear`) lo saca.
- `!parar` (`!cancelar`, `!stop`): frena el worker del hilo. El trabajo queda en su rama; mencionalo de nuevo en el hilo para retomarlo.
- `!aparte` (`!aside`): el bot ignora ese mensaje, con o sin mención. Sirve para hablar entre ustedes en el hilo mientras espera una respuesta.
- `!ayuda` (`!help`): la lista de comandos.

Para probar sin Slack:

```sh
node scripts/simulate.ts "arreglá https://github.com/org/repo/issues/12"
node scripts/simulate.ts --repo-path /ruta/a/repo/registrado/en/orca "Agregá un HELLO.md"
node scripts/simulate.ts --repo-path /ruta/a/repo --cancel-after 90 "Agregá un HELLO.md"
node scripts/simulate.ts --repo-path /ruta/a/repo "!pregunta ¿dónde se valida el token?"
```

Imprime lo que el bot publicaría y lee las respuestas a las preguntas por stdin. Los botones salen como líneas `:click <acción> <valor>`; pegar una por stdin la toca como `USIM` (`:click-as <usuario> …` para tocar como otro). `!repo …` corre una vez y guarda el repo del canal `SIM` en el `--state`. `--cancel-after <s>` manda `!parar` a los `s` segundos de arrancar el worker.

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
               │
               ├── worker_done ──▶ done (✅ / ❌, con link al PR)
               └── !parar ───────▶ cancelled (⏹️, la rama queda)
                                   (también desde starting y awaiting_answer)

  done o cancelled + nueva mención en el hilo
      ──▶ starting (follow-up: retoma la sesión de Claude en el mismo worktree)
```

## Tests

`npm test`
