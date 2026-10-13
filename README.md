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

   Si la app ya estaba instalada de antes, los archivos necesitan los scopes `files:read` (bajar lo que le mandás) y `files:write` (subir lo que genera el worker): agregalos desde el manifest o en OAuth & Permissions y reinstalala (**Install App → Reinstall to Workspace**). Sin `files:read`, Slack devuelve una página de login en vez del archivo y el bot avisa en el hilo que falta el scope.
7. `scripts/start-in-orca.sh`. Abre una terminal de Orca llamada `slack-bot` que corre `node --env-file=.env src/main.ts`. Tiene que correr dentro de Orca porque la Run de orquestación se ata a la terminal que la crea. Si ya hay un bot corriendo desde este directorio, muestra su pid y no arranca otro. Para reiniciarlo con código nuevo: `scripts/start-in-orca.sh --restart` (frena el bot, cierra su terminal y abre una nueva).

## Uso

- En el hilo de un mensaje con un issue (`https://github.com/org/repo/issues/12` o `org/repo#12`): `@alfred arreglalo`. El repo sale, en este orden, de tu mensaje (link, después nombre de un repo conocido), del hilo (link, después nombre), del repo del canal (`!repo`) y, si nada de eso, lo deduce Claude del hilo y avisa que lo dedujo.
- El mensaje `🫡 tomo …` trae un botón **⏹️ Parar** (lo mismo que `!parar`). Si el repo lo dedujo o es el del canal, trae también **Cambiar repo**: elegir otro frena el worker y rehace el pedido en ese repo. Los botones desaparecen cuando el trabajo termina.
- Un hilo es una tarea. Si el worker tiene una duda, el bot la publica en el hilo mencionándote. Respondé en el hilo sin mencionar al bot, o tocá una de las opciones si vino con hasta 5. Al responder, el mensaje muestra quién respondió qué y los botones se van.
- El reporte final trae un botón **Ver PR** si hay PR. Si el worker de una tarea ve que el pedido no necesitaba código (era una revisión o una pregunta), no abre PR y cierra con `✅ listo.` y el reporte.
- Solo los usuarios de `ALLOWED_SLACK_USERS` pueden tocar botones; a los demás el bot les contesta en privado y no cambia nada. Un botón viejo (de una pregunta ya respondida o un trabajo ya terminado) contesta en privado que ya no es válido.
- Mientras trabaja, cualquier mensaje tuyo en el hilo le llega como indicación extra. Avisa en el hilo con ⏳ cada hito (bug reproducido, causa encontrada, tests pasando, PR abierto), como mucho uno por minuto.
- Cuando terminó, mencionalo de nuevo en el mismo hilo para pedir cambios. Retoma la misma sesión de Claude sobre el mismo worktree y la misma rama. Cada mención elige el modo de esa corrida: sin comando es una tarea que termina en PR (por ejemplo `ahora arreglalo` después de un `!investiga`, recordando todo lo que investigó), `!investiga` investiga, `!revisa` revisa un PR y `!plan` muestra un plan antes de tocar código.
- Para otra tarea desde un hilo que ya tiene una, usá `!nuevo`: el bot la sigue en un hilo nuevo del canal.
- Archivos de ida: adjuntá imágenes, PDFs, logs o lo que sea a la mención, a mensajes anteriores del hilo o a una respuesta en el hilo mientras trabaja (sirve un archivo sin texto, también como respuesta a una pregunta). El bot los baja a `data/files/<hilo>/in/` y le pasa al worker la ruta de cada uno; `!pregunta` también los lee. No baja archivos de más de 50 MB ni los externos (Google Drive y similares), y avisa en el hilo cuáles no pudo bajar.
- Archivos de vuelta: el worker deja en `data/files/<hilo>/out/` lo que conviene que veas (capturas o un video corto de un cambio de UI, un PDF o deck, un log, un CSV). El bot los sube al hilo junto con la próxima pregunta, avance o reporte final, y los mueve a `out/sent/` para no subirlos dos veces. Si una subida falla, avisa con ⚠️ y sigue.

Menciones sin comando. Con `TYPESAFE_API_KEY` en `.env`, el bot le pregunta a Jev (TypeSafe) qué pedís: un cambio de código, una pregunta rápida (va por `!pregunta`, sin worker), una investigación, una revisión de PR, un plan, o nada (un gracias, un comentario al aire). Actúa solo si Jev está bastante seguro, con más exigencia para lo que escribe código: las rutas de solo lectura (pregunta, investigación, revisión) desde confianza 0.5, cambio y plan desde 0.8, y "nada" desde 0.8 (solo reacciona 👍). El mensaje de arranque dice cómo lo entendió (`(lo tomé como revisión; si no era eso, usá …)`). Si Jev duda, falla o tarda más de 5 segundos, pregunta `¿Qué querés que haga?` con los botones **Cambio de código**, **Pregunta rápida**, **Investigar**, **Revisar PR** y **Plan**, que corren eso con tu mensaje original. Un comando siempre gana y no consulta a Jev. Sin la clave, una mención sin comando es un cambio, como antes. Los umbrales salen de `node --env-file=.env scripts/eval-route.ts`, que corre los casos etiquetados de `eval/route-cases.json` contra la API real e imprime precisión, matriz de confusión y qué pasaría con cada umbral.

Comandos. Van como primera palabra después de la mención, sin importar mayúsculas ni tildes. Una palabra sin `!` es texto común.

- `!nuevo <pedido>` (`!new`): tarea aparte, en un hilo nuevo.
- `!pregunta <pregunta>` (`!ask`): respuesta rápida leyendo el repo en solo lectura, sin worktree ni PR, citando `archivo:línea` y la rama y el commit que leyó. Para algo que pide correr código o tests, usá `!investiga`.
- `!investiga <pregunta>` (`!investigate`): investigación a fondo con un worker, igual que una tarea (worktree, avances, preguntas con botones, `!parar`, archivos) pero sin PR: puede correr código, tests, la historia de git, `gh` y la web, y no commitea ni pushea. Cierra con `🔎 listo.` y un reporte con **Pregunta**, **Respuesta corta**, **Hallazgos** (con `archivo:línea` y evidencia), **Cómo lo verifiqué**, **Recomendación** y **Pendiente**; la evidencia (logs, CSV, capturas) sube al hilo.
- `!plan <pedido>` (`!planear`): una tarea que frena antes de escribir código. El worker entiende el pedido, escribe un plan y el bot lo publica (`📋 *Plan*`) con los botones **Aprobar** y **Cambiar**. **Aprobar** sigue hasta el PR. **Cambiar** te pide en privado que escribas en el hilo qué cambiar; lo que escribas (también sin tocar el botón) vuelve al worker, que corrige el plan y lo vuelve a mostrar. Un plan sin cambios no se publica dos veces.
- `!revisa <PR> [qué mirar]` (`!review`, `!revisar`): revisión de un PR existente (link, `owner/repo#n`, o `#n` si el repo sale del hilo o del canal) con un worker en solo lectura: puede hacer `gh pr checkout` y correr tests, lint y typecheck, pero no commitea, no pushea, no aprueba ni pide cambios, y deja el worktree como lo encontró. Solo comenta en GitHub si se lo pedís (por ejemplo `dejá el review en GitHub`), con un único comentario. Arranca con `🔍 reviso …` y cierra con `🔍 revisé owner/repo#n.`, el botón **Ver PR** y un reporte con **Veredicto** (listo para mergear, cambios menores o bloqueante), **Hallazgos** (por severidad, con `archivo:línea`), **Qué verifiqué**, **Sugerencias** y **Pendiente**.
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
node scripts/simulate.ts --repo-path /ruta/a/repo "!investiga ¿por qué falla el build?"
node scripts/simulate.ts --repo-path /ruta/a/repo --follow-up "ahora arreglalo" "!investiga ¿por qué falla el build?"
node scripts/simulate.ts --repo-path /ruta/a/repo "!plan Agregá un HELLO.md"
node scripts/simulate.ts --repo-path /ruta/a/repo --attach captura.png "Leé la imagen adjunta y decime qué dice"
```

Imprime lo que el bot publicaría y lee las respuestas a las preguntas por stdin. Los botones salen como líneas `:click <acción> <valor>`; pegar una por stdin la toca como `USIM` (`:click-as <usuario> …` para tocar como otro). `!repo …` corre una vez y guarda el repo del canal `SIM` en el `--state`. `--cancel-after <s>` manda `!parar` a los `s` segundos de arrancar el worker. `--attach <archivo>` (repetible) adjunta un archivo local al pedido como si viniera de Slack; lo que el worker deja en su carpeta de salida sale como `[archivo] <nombre> (<bytes> bytes)` en vez de subirse.

## Escribir en el hilo desde cualquier sesión

`scripts/thread.ts` deja que una sesión de Claude abierta en el worktree de un job (por ejemplo desde Orca, después de que el worker terminó) escriba en el hilo de Slack de ese job como Alfred y lea lo que le contestan:

```bash
node --env-file=.env scripts/thread.ts post --to salva --text-file decisiones.md [--file captura.png] [--dry-run]
node --env-file=.env scripts/thread.ts read [--since <ts>] [--from salva] [--all]
node --env-file=.env scripts/thread.ts wait --from salva [--since <ts>] [--timeout 30]
```

Sin `--thread <canal>:<ts>`, el hilo es el del job de `data/state.json` cuyo worktree contiene el directorio actual. `post` convierte el Markdown a mrkdwn, menciona primero a los `--to` y parte en varios mensajes lo que no entra en uno. `wait` revisa el hilo cada 20 s y sale con código 2 si vence el timeout. El skill `skills/slack-thread` le explica a cualquier sesión cuándo y cómo usarlo; se instala con `ln -s /home/facu/orca/projects/slack-bot/skills/slack-thread ~/.claude/skills/slack-thread`.

Lo que postea el CLI lo ignora el bot (descarta mensajes de bots), y una respuesta de alguien que no está en `ALLOWED_SLACK_USERS` no le llega a ningún worker.

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

Cada corrida tiene un modo (`Job.mode`): `change` (la tarea común, termina en PR), `investigate` (`!investiga`, termina en un reporte sin PR) o `plan` (`!plan`, una `change` con una pregunta de aprobación antes de implementar). El modo cambia la spec del worker, el mensaje de arranque y el reporte final; los estados son los mismos. El plan lo escribe el worker en `data/reports/<hilo>.plan.md`; cuando llega una pregunta de un job en modo plan y ese archivo cambió desde la última vez, el bot lo publica antes de la pregunta. Va en un mensaje propio porque el mensaje de la pregunta se reescribe al responderla; así el plan aprobado queda en el hilo. Usa bloques de hasta 3000 caracteres en vez del corte de 3500 de los reportes, así que solo se recorta un plan de más de 39.000 caracteres.

## Tests

`npm test`
