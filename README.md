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

   Si la app ya estaba instalada de antes, los pedidos de compañeros (`APPROVAL_SLACK_USERS`) necesitan el scope `im:write` (para mandarle el DM al dueño) y en **App Home** la **Messages Tab** activada; está en el manifest, y como suma un scope hay que reinstalar.

   Las instrucciones privadas por DM (ver abajo) necesitan el evento `message.im`, el scope `im:history` y, en **App Home → Messages Tab**, "Allow users to send Slash commands and messages from the messages tab" prendido. Están en el manifest; como suma un scope, hay que reinstalar.

   Los archivos necesitan los scopes `files:read` (bajar lo que le mandás) y `files:write` (subir lo que genera el worker): agregalos desde el manifest o en OAuth & Permissions y reinstalala (**Install App → Reinstall to Workspace**). Sin `files:read`, Slack devuelve una página de login en vez del archivo y el bot avisa en el hilo que falta el scope.
7. `scripts/start-in-orca.sh`. Arranca el bot en segundo plano: abre una terminal de Orca (Orca solo ata la Run de orquestación desde una terminal viva), lanza `node --env-file=.env src/main.ts` desprendido de ella y, cuando el bot se conecta a Slack, cierra la terminal. Orca sigue atendiendo al proceso. Los logs quedan en `data/bot.log` (`tail -f data/bot.log`). Si ya hay un bot corriendo desde este directorio, muestra su pid y no arranca otro. Para reiniciarlo con código nuevo: `scripts/start-in-orca.sh --restart`. Si no se conecta en 60 s, deja la terminal abierta y muestra el log.

## Uso

- En el hilo de un mensaje con un issue (`https://github.com/org/repo/issues/12` o `org/repo#12`): `@alfred arreglalo`. El repo sale, en este orden, de tu mensaje (link, después nombre de un repo conocido), del hilo (link, después nombre), del repo del canal (`!repo`) y, si nada de eso, lo deduce Claude del hilo y avisa que lo dedujo.
- El mensaje `🫡 tomo …` trae un botón **⏹️ Parar** (lo mismo que `!parar`). Si el repo lo dedujo o es el del canal, trae también **Cambiar repo**: elegir otro frena el worker y rehace el pedido en ese repo. Los botones desaparecen cuando el trabajo termina.
- Un hilo es una tarea. Si el worker tiene una duda, el bot la publica en el hilo mencionándote. Respondé en el hilo sin mencionar al bot, o tocá una de las opciones si vino con hasta 5. Al responder, el mensaje muestra quién respondió qué y los botones se van.
- El reporte final trae un botón **Ver PR** si hay PR. Si el worker de una tarea ve que el pedido no necesitaba código (era una revisión o una pregunta), no abre PR y cierra con `✅ listo.` y el reporte.
- Solo los usuarios de `ALLOWED_SLACK_USERS`, y el compañero que pidió el trabajo (ver abajo), pueden tocar botones; a los demás el bot les contesta en privado y no cambia nada. Un botón viejo (de una pregunta ya respondida o un trabajo ya terminado) contesta en privado que ya no es válido.
- Mientras trabaja, cualquier mensaje tuyo en el hilo le llega como indicación extra. Avisa en el hilo con ⏳ cada hito (bug reproducido, causa encontrada, tests pasando, PR abierto), como mucho uno por minuto.
- Cuando terminó, mencionalo de nuevo en el mismo hilo para pedir cambios. Retoma la misma sesión de Claude sobre el mismo worktree y la misma rama. Cada mención elige el modo de esa corrida: sin comando es una tarea que termina en PR (por ejemplo `ahora arreglalo` después de un `!investiga`, recordando todo lo que investigó), `!investiga` investiga, `!revisa` revisa un PR y `!plan` muestra un plan antes de tocar código.
- Si un hilo nuevo apunta a un issue o PR que otro hilo ya trabajó (mismo repo y número, o el PR que abrió ese hilo), el bot lo avisa con `🔗 esto ya se trabajó en <link al hilo> (estado, PR)`, hasta los 3 más recientes, y le pasa al worker el modo, el resultado, el PR y el resumen de cada uno.
- Para otra tarea desde un hilo que ya tiene una, usá `!nuevo`: el bot la sigue en un hilo nuevo del canal.
- Archivos de ida: adjuntá imágenes, PDFs, logs o lo que sea a la mención, a mensajes anteriores del hilo o a una respuesta en el hilo mientras trabaja (sirve un archivo sin texto, también como respuesta a una pregunta). El bot los baja a `data/files/<hilo>/in/` y le pasa al worker la ruta de cada uno; `!pregunta` también los lee. No baja archivos de más de 50 MB ni los externos (Google Drive y similares), y avisa en el hilo cuáles no pudo bajar.
- Archivos de vuelta: el worker deja en `data/files/<hilo>/out/` lo que conviene que veas (capturas o un video corto de un cambio de UI, un PDF o deck, un log, un CSV). El bot los sube al hilo junto con la próxima pregunta, avance o reporte final, y los mueve a `out/sent/` para no subirlos dos veces. Si una subida falla, avisa con ⚠️ y sigue.

Pedidos de compañeros. `ALLOWED_SLACK_USERS` son los dueños: piden sin aprobación y aprueban lo de los demás. `APPROVAL_SLACK_USERS` (IDs separados por coma) son compañeros que pueden mencionar al bot, pero nada de lo que piden arranca solo. El bot resuelve el repo y la ruta (Jev o los botones de ruta) como siempre, reacciona 👀 a la mención y le manda a cada dueño un DM con quién pidió, el canal y el link al mensaje, el pedido citado, el repo y qué haría (cambio de código con PR, revisión de PR, pregunta rápida…), los archivos adjuntos y los botones **Aprobar** y **Rechazar**. Gana la primera decisión de cualquier dueño y los DMs muestran el resultado. **Aprobar** corre el pedido exactamente como si lo hubiera hecho un dueño, pero a nombre del compañero: las preguntas del worker y el reporte lo mencionan a él. **Rechazar** deja en el hilo `🙅 por ahora no puedo tomar este pedido.` y no corre nada. Un pedido sin decidir vence a las 24 h y el hilo dice que no se pudo tomar. El compañero no ve nada de la aprobación: ni el dueño ni la palabra aparecen en el hilo. Los pedidos pendientes viven en `data/state.json`, así que un reinicio no los pierde. Dentro de su trabajo aprobado, el compañero responde las preguntas del worker (escribiendo o con botones), le manda indicaciones en el hilo y lo frena con `!parar` sin pedir aprobación. Otro compañero en ese hilo se ignora. Un nuevo pedido en el hilo (por ejemplo después de que terminó) vuelve a pedir aprobación. `!repo` solo muestra para un compañero (fijarlo o borrarlo se rechaza), cambiar el repo de un trabajo en curso es de los dueños, y `!ayuda` y `!aparte` funcionan igual. Cualquier otra persona recibe el rechazo de siempre.

Instrucciones privadas por DM. Un dueño puede hablar en privado con la sesión de un hilo, o pedirle que le escriba a alguien ahí, sin que nadie en el hilo se entere. Mandale un DM a Alfred con el link de cualquier mensaje del hilo (copiá el link del mensaje; sirve el de una respuesta) y qué querés:

```
https://<ws>.slack.com/archives/C0…/p1791…  ¿por qué elegiste guardar los permisos en la tabla de agentes?
https://<ws>.slack.com/archives/C0…/p1791…  preguntale a @salva por qué guardó los permisos en la tabla de agentes
https://<ws>.slack.com/archives/C0…/p1791…  avisale a @sebas que el PR está listo
```

Alfred contesta como respuesta en el hilo de tu DM: el 👌, la respuesta privada, el ✅, lo que contestó la persona (aunque llegue horas después), el ⌛ y los errores. Después seguí sin el link. Lo que escribas dentro de ese hilo de DM va al hilo de trabajo de ese DM, aunque mientras tanto hayas hablado de otro. Un DM nuevo sin link va al último hilo del que le hablaste, y un link siempre manda. Cada DM retoma la misma sesión de Claude, así que la charla sigue: primero `¿qué quedó pendiente?` y después `dale, escribile a @salva lo que hablamos`. Cada respuesta del bot nombra el hilo, para que sepas adónde fue un DM sin link.

- El bot retoma la sesión de Claude de ese hilo, en el mismo worktree, en solo lectura: no commitea, no pushea, no comenta en GitHub. Te contesta por DM `👌 voy con eso en <link del hilo>` y en el hilo no aparece nada: ni mensaje de arranque, ni reacciones, ni ⏳.
- Si no le pedís escribirle o etiquetar a alguien en el hilo (una pregunta, un resumen, su opinión), el worker te contesta solo a vos: te llega `💬 en <link del hilo>:` con la respuesta, con `archivo:línea` donde la respalda, y en el hilo no pasa nada. Si nombrás a alguien sin dejar claro que hay que escribirle, también contesta en privado y te dice qué escribiría si se lo pedís.
- Si le pedís escribir en el hilo, el worker escribe el mensaje con lo que sabe de su propio trabajo, en su voz, en castellano y corto (decisiones con `archivo:línea` o el link al PR), y el bot lo publica en el hilo tal cual. El mensaje no te menciona ni dice que alguien lo pidió. Las personas que nombrás (`@salva` escrito a mano o elegido de la lista) se resuelven en Slack y el mensaje las menciona.
- Si es un aviso, te llega `✅ listo: <link al mensaje>`. Si es una pregunta, el bot espera la primera respuesta en el hilo de esa persona (o de un dueño), aunque no tenga acceso al bot y aunque responda mencionándolo. Con esa respuesta retoma la sesión otra vez, la toma como opinión y no como orden, no cambia código, y te manda por DM qué contestó, si cambia algo de lo que hizo y qué recomienda. Respuestas posteriores, o de otros, no hacen nada. Si nadie contesta en 24 h, te llega `⌛ salva no respondió en <link>`.
- Una mención tuya en el hilo mientras espera corta la espera, como cualquier pedido nuevo. Otro DM tuyo para ese hilo también la corta y arranca la instrucción nueva.
- Un nombre que no existe en Slack no frena nada si solo lo mencionás; si el worker le tendría que escribir, el bot no publica y te dice `no encontré a "zoe" en Slack`. Tampoco publica un mensaje que mencione o espere a alguien que no nombraste.
- Todo error (primer DM sin link, hilo sin trabajo, hilo trabajando, nombre que no existe en Slack, sesión que no se puede retomar, worker que falla) te llega por DM y en el hilo no pasa nada. Los DMs de cualquiera que no esté en `ALLOWED_SLACK_USERS` se ignoran sin respuesta.

Repos que maneja. `ALFRED_REPOS` en `.env` (separados por coma, por nombre de repo o de Orca) limita los repos que lista `!repo`, los del menú **Cambiar repo** y entre los que deduce el repo cuando no lo nombrás. Un link explícito a otro repo se sigue tomando. Vacía, usa todos los repos de GitHub que tenga Orca.

Canales atados a una carpeta local. Para trabajar en una carpeta que no es un repo de GitHub (por ejemplo `/home/facu/orca/projects/mkt-fyso`, el material de marketing), atá un canal a ella con `ALFRED_DIRS` en `.env`: `ALFRED_DIRS=C0123ABC=/home/facu/orca/projects/mkt-fyso` (varios separados por coma). Va por el ID del canal porque el bot no tiene `channels:read`: en Slack abrí el canal, tocá su nombre arriba y el ID (`C…`) está al final de la pestaña **Acerca de** (**About**), con un botón para copiarlo. La carpeta tiene que estar en Orca (`orca repo add --path <ruta>`). Al arrancar, el bot dice en el log qué canales ató y saltea, avisando, las entradas mal escritas o cuya carpeta no existe o no está en Orca. Para tomar un cambio, reiniciá el bot.

- Todo lo que se pide en ese canal corre en esa carpeta, sin worktree, sin ramas y sin PR. El worker trabaja sobre la carpeta misma, sigue su `CLAUDE.md` y `AGENTS.md`, edita en el lugar y al final commitea localmente solo los archivos que creó o cambió (nunca `.mcp.json`, `.claude/`, `.agents/` ni secretos). No borra ni mueve archivos que no creó salvo que se lo pidas, y nada limpia ni resetea la carpeta: lo que no está commiteado queda como estaba.
- Un link o un nombre de repo de GitHub en el pedido no lo lleva a otro lado. El cierre es `✅ listo en <carpeta>.` con el reporte y la lista de archivos que commiteó esa corrida. Lo que conviene que veas (imágenes, documentos) sube al hilo como siempre.
- Un pedido por vez. Si la carpeta está ocupada con el pedido de otro hilo, contesta `estoy con otro pedido en <carpeta> (<link>); avisame cuando termine` y no arranca nada. Las menciones de seguimiento en el mismo hilo retoman la misma sesión en la misma carpeta. Las instrucciones privadas por DM funcionan igual; si la carpeta está ocupada, te lo dice por DM.
- `!investiga` y `!plan` funcionan igual. `!pregunta` lee la carpeta tal como está (rama y commit locales, o "sin commits"). `!revisa` no aplica porque no hay PRs. `!repo` muestra la carpeta y no deja fijar otro repo en ese canal. En los demás canales nada cambia: la carpeta aparece en la lista de `!repo` como `carpeta local`, pero nunca se elige al deducir un repo.

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
node scripts/simulate.ts --repo-path /ruta/a/repo --as UTEAM "!pregunta ¿qué hace el README?"
node scripts/simulate.ts --repo-path /ruta/a/repo --dm "preguntale a @salva si le parece bien" --reply-as USALVA --reply "dale" "!investiga ¿qué hay en la raíz?"
node scripts/simulate.ts --dir /ruta/a/carpeta/en/orca "creá un archivo notas.md con 3 ideas de posts"
```

Imprime lo que el bot publicaría y lee las respuestas a las preguntas por stdin. Los botones salen como líneas `:click <acción> <valor>`; pegar una por stdin la toca como `USIM` (`:click-as <usuario> …` para tocar como otro). `!repo …` corre una vez y guarda el repo del canal `SIM` en el `--state`. `--cancel-after <s>` manda `!parar` a los `s` segundos de arrancar el worker. `--as <usuario>` menciona y responde como otro usuario: `USIM` es el dueño, los IDs de `--teammates` (por defecto `UTEAM`) son compañeros cuyo pedido sale como `[slack → DM a USIM]` con sus botones, y cualquier otro recibe el rechazo. `--attach <archivo>` (repetible) adjunta un archivo local al pedido como si viniera de Slack; lo que el worker deja en su carpeta de salida sale como `[archivo] <nombre> (<bytes> bytes)` en vez de subirse. `--dm "<texto>"` (repetible), cuando el trabajo terminó, le manda al bot como `USIM` un DM con ese texto: el primero con el link del hilo, los siguientes sin link y dentro del hilo de DM del primero, en orden; `--reply "<texto>"` responde en el hilo como `--reply-as` (por defecto `USALVA`) si el bot quedó esperando esa respuesta. `--dir <carpeta>` ata el canal simulado a esa carpeta local, como `ALFRED_DIRS` (tiene que estar en Orca). `--users <id=nombre,…>` es la lista de personas de Slack para resolver los `@nombre` (por defecto `USALVA=salva,USEBAS=sebas`).

## Escribir en el hilo desde cualquier sesión

`scripts/thread.ts` deja que una sesión de Claude abierta en el worktree de un job (por ejemplo desde Orca, después de que el worker terminó) escriba en el hilo de Slack de ese job como Alfred y lea lo que le contestan:

```bash
node --env-file=.env scripts/thread.ts post --to salva --text-file decisiones.md [--file captura.png] [--dry-run]
node --env-file=.env scripts/thread.ts read [--since <ts>] [--from salva] [--all]
node --env-file=.env scripts/thread.ts wait --from salva [--since <ts>] [--timeout 30]
```

Sin `--thread <canal>:<ts>`, el hilo es el del job de `data/state.json` cuyo worktree contiene el directorio actual. `post` convierte el Markdown a mrkdwn, menciona primero a los `--to` y parte en varios mensajes lo que no entra en uno. `wait` revisa el hilo cada 20 s y sale con código 2 si vence el timeout. El skill `skills/slack-thread` le explica a cualquier sesión cuándo y cómo usarlo; se instala con `ln -s /home/facu/orca/projects/slack-bot/skills/slack-thread ~/.claude/skills/slack-thread`.

Lo que postea el CLI lo ignora el bot (descarta mensajes de bots), y una respuesta de alguien que no está en `ALLOWED_SLACK_USERS` no le llega a ningún worker, salvo la respuesta que espera una instrucción privada por DM.

## Cómo funciona

Un solo proceso Node. Al arrancar retoma la Run guardada con `orca orchestration run-use` (o crea una nueva) y persiste todo en `data/state.json`. Cada mención crea un Job por hilo, busca el repo en Orca (lo clona si no está) y lanza `orca orchestration worker-start` con una spec que obliga a leer el issue, commitear, pushear, abrir el PR y cerrar con `worker_done` incluyendo `PR: <url>`. En un canal atado a una carpeta local, el worker arranca sobre el worktree principal de esa carpeta (`--worktree path:<carpeta>`), nunca en uno nuevo; al terminar, `worker-release` solo cierra su terminal. Un loop hace `orca orchestration check --wait`, rutea cada mensaje al Job por `dispatchId`, publica en Slack, marca el mensaje como procesado y recién después hace ack del lote, así un reinicio no pierde ni duplica avisos. Las transiciones están todas en `src/jobs.ts`.

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

  done o cancelled + DM de un dueño (con el link del hilo, o sin link si es su último hilo)
      ──▶ relaying (contesta o escribe el mensaje) ──┬─ respuesta privada, aviso, error o !parar ──▶ el done/cancelled de antes
                                                     └─ espera respuesta ──▶ awaiting_reply
  awaiting_reply ── primera respuesta ──▶ relaying (resume la respuesta por DM) ──▶ el done/cancelled de antes
                 ── 24 h ──────────────▶ el done/cancelled de antes
                 ── mención o DM de un dueño ──▶ starting / relaying
```

Cada corrida tiene un modo (`Job.mode`): `change` (la tarea común, termina en PR), `investigate` (`!investiga`, termina en un reporte sin PR) o `plan` (`!plan`, una `change` con una pregunta de aprobación antes de implementar). El modo cambia la spec del worker, el mensaje de arranque y el reporte final; los estados son los mismos. El plan lo escribe el worker en `data/reports/<hilo>.plan.md`; cuando llega una pregunta de un job en modo plan y ese archivo cambió desde la última vez, el bot lo publica antes de la pregunta. Va en un mensaje propio porque el mensaje de la pregunta se reescribe al responderla; así el plan aprobado queda en el hilo. Usa bloques de hasta 3000 caracteres en vez del corte de 3500 de los reportes, así que solo se recorta un plan de más de 39.000 caracteres.

## Tests

`npm test`
