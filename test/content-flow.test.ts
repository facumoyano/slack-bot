import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClick } from "../src/blocks.ts";
import type { Block } from "../src/blocks.ts";
import { drainContent, handleClick, handleMention, handleThreadReply } from "../src/bot.ts";
import { processBatch } from "../src/inbox.ts";
import { sweepManifests } from "../src/intake.ts";
import type { InboxMessage } from "../src/jobs.ts";
import { openStore } from "../src/store.ts";
import { fakes } from "./fakes.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const CH = "CMKT0001";
const SALVA = "U0SALVA01";
const ID = "2026-10-21-instagram";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "content-flow-"));
  const dir = join(base, "mkt");
  const root = join(base, "contenido");
  mkdirSync(join(dir, "img"), { recursive: true });
  mkdirSync(join(root, "entrada"), { recursive: true });
  writeFileSync(join(dir, "img", "a.png"), PNG);
  writeFileSync(join(dir, "img", "b.png"), PNG);
  let dispatches = 0;
  const f = fakes({
    async startInWorktree(o) {
      f.calls.push(`followup ${o.worktree}`);
      f.specs.push(o.spec);
      dispatches += 1;
      return { taskId: `t${dispatches}`, dispatchId: `dc${dispatches}` };
    },
  });
  f.deps.dirs = { [CH]: { name: "mkt", path: dir } };
  f.deps.approvalUsers = new Set([SALVA]);
  const runs: Promise<void>[] = [];
  f.deps.onDirFree = (path) => {
    const run = drainContent(f.deps, path);
    if (run) runs.push(run);
  };
  const drop = (name: string, body: unknown) => writeFileSync(join(root, "entrada", name), typeof body === "string" ? body : JSON.stringify(body));
  const sweep = () => sweepManifests(f.deps, root);
  const folder = (name: string) => (existsSync(join(root, name)) ? readdirSync(join(root, name)) : []);
  return { f, dir, root, drop, sweep, folder, runs };
}

function proposal(dir: string, over: Record<string, unknown> = {}) {
  return {
    tipo: "propuesta",
    id: ID,
    version: 1,
    canal: CH,
    red: "instagram",
    fecha: "2026-10-21",
    hora: "12:30",
    titulo: "Lanzamiento",
    texto: "Llega Fyso.",
    imagenes: [join(dir, "img", "a.png"), join(dir, "img", "b.png")],
    archivo: "contenido/x.md",
    buffer_id: "buf-1",
    ...over,
  };
}

const calendar = { tipo: "calendario", id: "2026-W43", version: 1, canal: CH, titulo: "Semana 43", texto: "- lunes: reel", archivo: "estrategia/calendario.json" };

function buttons(blocks: Block[] | undefined) {
  return (blocks ?? []).flatMap((b) => (b.type === "actions" ? b.elements : [])) as { action_id: string; value: string; text: { text: string } }[];
}

/** Clicks a button of the message at `messageTs` as `user`, the way Slack sends it. */
function click(f: ReturnType<typeof fakes>, blocks: Block[] | undefined, label: string, user: string, messageTs: string, threadTs = messageTs) {
  const b = buttons(blocks).find((x) => x.text.text === label)!;
  return handleClick(f.deps, { click: parseClick(b.action_id, b.value)!, user, channel: CH, threadTs, messageTs });
}

const done = (id: string, dispatchId: string): InboxMessage => ({ id, type: "worker_done", body: "listo", payload: JSON.stringify({ dispatchId, outcome: "succeeded" }) });
const requests = (f: ReturnType<typeof fakes>) => f.specs.map((s) => /\/contenido [^\n]*/.exec(s)?.[0]);

test("a propuesta manifest posts one message with buttons, uploads its images into that thread and is moved to procesados", async () => {
  const { f, dir, drop, sweep, folder } = setup();
  drop("p1.json", proposal(dir));
  await sweep();

  assert.equal(f.tops.length, 1);
  assert.equal(f.tops[0].channel, CH);
  assert.match(f.tops[0].text, /^📣 \*Lanzamiento\*/);
  assert.deepEqual(buttons(f.tops[0].blocks).map((b) => b.text.text), ["Aprobar", "Rechazar"]);
  assert.deepEqual(f.uploads, [join(dir, "img", "a.png"), join(dir, "img", "b.png")]);
  assert.deepEqual(f.uploadThreads, ["200.1", "200.1"]);
  assert.deepEqual(folder("entrada"), []);
  assert.deepEqual(folder("procesados"), ["p1.json"]);
  assert.deepEqual(f.store.data.contents[`propuesta:${ID}`], { kind: "propuesta", id: ID, channel: CH, threadTs: "200.1", version: 1, msgTs: "200.1", text: f.tops[0].text, state: { kind: "pending" } });
});

test("the same manifest again, or the same version under another name, posts nothing", async () => {
  const { f, dir, drop, sweep, folder } = setup();
  drop("p1.json", proposal(dir));
  await sweep();
  drop("p1.json", proposal(dir));
  drop("p1-copia.json", proposal(dir));
  await sweep();

  assert.equal(f.tops.length, 1);
  assert.equal(f.messages.length, 0);
  assert.equal(f.uploads.length, 2);
  assert.equal(folder("procesados").length, 3);
});

test("version 2 posts in the original's thread with fresh buttons and retires version 1's", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();
  drop("p1-v2.json", proposal(dir, { version: 2, texto: "Llega Fyso, ahora más corto.", imagenes: [join(dir, "img", "b.png")] }));
  await sweep();

  assert.equal(f.tops.length, 1);
  const v2 = f.messages.at(-1)!;
  assert.equal(v2.thread, "200.1");
  assert.match(v2.text, /ahora más corto/);
  assert.deepEqual(buttons(v2.blocks).map((b) => b.text.text), ["Aprobar", "Rechazar"]);
  const retired = f.updates.find((u) => u.ts === "200.1")!;
  assert.equal(retired.text, `${f.tops[0].text}\n\n_reemplazada por la versión 2_`);
  assert.deepEqual(buttons(retired.blocks), []);
  assert.deepEqual(f.uploadThreads, ["200.1", "200.1", "200.1"]);
  assert.equal(f.store.data.contents[`propuesta:${ID}`].version, 2);
  assert.equal(f.store.data.contents[`propuesta:${ID}`].msgTs, v2.ts);
});

test("a half-written file is left for the next pass and posted once complete", async () => {
  const { f, dir, drop, sweep, folder } = setup();
  const full = JSON.stringify(proposal(dir));
  drop("p1.json", full.slice(0, 40));
  await sweep();
  assert.equal(f.tops.length, 0);
  assert.deepEqual(folder("entrada"), ["p1.json"]);
  assert.deepEqual(f.dms, []);

  drop("p1.json", full);
  await sweep();
  assert.equal(f.tops.length, 1);
  assert.deepEqual(folder("procesados"), ["p1.json"]);
});

test("a file still unparseable two minutes after its last write goes to errores and the owners get the reason", async () => {
  const { f, root, drop, sweep, folder } = setup();
  drop("roto.json", "{\"tipo\": \"propu");
  const old = new Date(Date.now() - 3 * 60_000);
  utimesSync(join(root, "entrada", "roto.json"), old, old);
  f.clock.now = Date.now();
  await sweep();

  assert.deepEqual(folder("errores"), ["roto.json"]);
  assert.deepEqual(f.dms.map((d) => [d.user, d.text]), [
    ["U1", "⚠️ descarté el manifiesto de contenido `roto.json`: no es JSON válido (esperé 2 minutos por si se estaba escribiendo)"],
    ["U2", "⚠️ descarté el manifiesto de contenido `roto.json`: no es JSON válido (esperé 2 minutos por si se estaba escribiendo)"],
  ]);
  assert.equal(f.tops.length, 0);
});

test("an invalid manifest goes to errores with a one-line DM to each owner, and nothing is uploaded", async () => {
  const { f, dir, drop, sweep, folder } = setup();
  drop("p1.json", proposal(dir, { imagenes: [join(dir, "..", "..", "etc", "passwd")] }));
  drop("p2.json", proposal(dir, { id: "otro", imagenes: ["/etc/hostname"] }));
  await sweep();

  assert.deepEqual(folder("errores").sort(), ["p1.json", "p2.json"]);
  assert.equal(f.dms.length, 4);
  assert.match(f.dms[2].text, /^⚠️ descarté el manifiesto de contenido `p2.json`: la imagen `\/etc\/hostname` está fuera de la carpeta del canal$/);
  assert.deepEqual(f.uploads, []);
  assert.equal(f.tops.length, 0);
});

test("an owner's Aprobar starts the literal request in the content thread's directory, with no approval DM, and retires the buttons", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();

  await click(f, f.tops[0].blocks, "Aprobar", "U1", "200.1");

  assert.deepEqual(requests(f), [`/contenido aprobar ${ID} por Facu`]);
  assert.ok(f.calls.includes(`followup path:${dir}`));
  const job = f.store.data.jobs[`${CH}:200.1`];
  assert.equal(job.state.kind, "working");
  assert.equal(job.request, `/contenido aprobar ${ID} por Facu`);
  assert.equal(job.slack.requester, "U1");
  assert.ok(f.messages.some((m) => m.thread === "200.1" && m.text === "🫡 voy con eso…"));
  const retired = f.updates.find((u) => u.ts === "200.1")!;
  assert.equal(retired.text, `${f.tops[0].text}\n\n✅ aprobado por Facu`);
  assert.deepEqual(buttons(retired.blocks), []);
  assert.deepEqual(f.dms, []);
  assert.deepEqual(f.store.data.approvals, {});
});

test("Salva, an approval user, rejects directly: the request names Salva and no owner is asked", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();

  await click(f, f.tops[0].blocks, "Rechazar", SALVA, "200.1");

  assert.deepEqual(requests(f), [`/contenido rechazar ${ID} por Salva`]);
  assert.equal(f.store.data.jobs[`${CH}:200.1`].slack.requester, SALVA);
  assert.equal(f.updates.find((u) => u.ts === "200.1")!.text, `${f.tops[0].text}\n\n🚫 rechazado por Salva`);
  assert.deepEqual(f.dms, []);
});

test("a stranger's click is refused in private and changes nothing", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();

  await click(f, f.tops[0].blocks, "Aprobar", "UNOBODY01", "200.1");

  assert.deepEqual(f.ephemerals, ["UNOBODY01: no podés aprobar este contenido"]);
  assert.deepEqual(f.specs, []);
  assert.deepEqual(f.updates, []);
  assert.equal(f.store.data.contents[`propuesta:${ID}`].state.kind, "pending");
});

test("a double click, even simultaneous, runs once; the second one hears it was already decided", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();

  await Promise.all([click(f, f.tops[0].blocks, "Aprobar", "U1", "200.1"), click(f, f.tops[0].blocks, "Aprobar", SALVA, "200.1")]);
  await click(f, f.tops[0].blocks, "Rechazar", "U1", "200.1");

  assert.deepEqual(requests(f), [`/contenido aprobar ${ID} por Facu`]);
  assert.deepEqual(f.ephemerals, [`${SALVA}: ya decidido`, "U1: ya decidido"]);
});

test("a click on a replaced version is refused: there is a newer one", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();
  drop("p1-v2.json", proposal(dir, { version: 2 }));
  await sweep();

  await click(f, f.tops[0].blocks, "Aprobar", "U1", "200.1");
  assert.deepEqual(f.ephemerals, ["U1: hay una versión más nueva"]);
  assert.deepEqual(f.specs, []);

  const v2 = f.messages.at(-1)!;
  await click(f, v2.blocks, "Aprobar", "U1", v2.ts, "200.1");
  assert.deepEqual(requests(f), [`/contenido aprobar ${ID} por Facu`]);
});

test("a calendario's Aprobar sends calendario-aprobado", async () => {
  const { f, drop, sweep } = setup();
  drop("cal.json", calendar);
  await sweep();
  await click(f, f.tops[0].blocks, "Aprobar", SALVA, "200.1");
  assert.deepEqual(requests(f), ["/contenido calendario-aprobado 2026-W43 por Salva"]);
});

test("a plain reply in a propuesta's thread asks for the change, with its files; a stranger's reply and !aparte are ignored", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();

  assert.equal(await handleThreadReply(f.deps, { channel: CH, threadTs: "200.1", ts: "200.5", user: "UNOBODY01", text: "cambialo todo" }), true);
  assert.equal(await handleThreadReply(f.deps, { channel: CH, threadTs: "200.1", ts: "200.6", user: SALVA, text: "!aparte ¿lo vieron?" }), true);
  assert.deepEqual(f.specs, []);

  f.slackFiles["https://files.slack.test/ref.png"] = new Response(PNG);
  const files = [{ id: "F1", name: "ref.png", mimetype: "image/png", size: PNG.length, url_private_download: "https://files.slack.test/ref.png" }];
  await handleThreadReply(f.deps, { channel: CH, threadTs: "200.1", ts: "200.7", user: SALVA, text: "más corto y sin emojis", files });

  assert.deepEqual(requests(f), [`/contenido cambiar ${ID} por Salva: más corto y sin emojis`]);
  assert.match(f.specs[0], /ref\.png \(ref\.png, image\/png\)/);
  assert.equal(f.store.data.jobs[`${CH}:200.1`].slack.requester, SALVA);
  assert.deepEqual(f.ephemerals, []);
});

test("a plain reply in a calendario's thread sends calendario-cambiar", async () => {
  const { f, drop, sweep } = setup();
  drop("cal.json", calendar);
  await sweep();
  await handleThreadReply(f.deps, { channel: CH, threadTs: "200.1", ts: "200.5", user: "U1", text: "el martes va un carrusel" });
  assert.deepEqual(requests(f), ["/contenido calendario-cambiar 2026-W43 por Facu: el martes va un carrusel"]);
});

test("three actions while the directory is busy are queued and run one after another, in order, once each as each job ends", async () => {
  const { f, dir, drop, sweep, runs } = setup();
  drop("p1.json", proposal(dir));
  drop("p2.json", proposal(dir, { id: "otro" }));
  await sweep();
  await handleMention(f.deps, { channel: CH, threadTs: "300.1", ts: "300.1", user: "U1", text: "armá el calendario" });
  assert.equal(f.specs.length, 1);

  await click(f, f.tops[0].blocks, "Aprobar", SALVA, "200.1");
  await click(f, f.tops[1].blocks, "Rechazar", "U1", "200.2");
  await handleThreadReply(f.deps, { channel: CH, threadTs: "200.1", ts: "200.9", user: SALVA, text: "otra foto" });

  assert.equal(f.specs.length, 1, "nothing else started");
  assert.deepEqual(f.store.data.contentQueues[dir].map((q) => q.action.kind), ["aprobar", "rechazar", "cambiar"]);
  assert.deepEqual(
    f.messages.filter((m) => m.text.startsWith("⏳ en cola")).map((m) => [m.thread, m.text]),
    [1, 2, 3].map((n, i) => [["200.1", "200.2", "200.1"][i], `⏳ en cola: mkt está con otro pedido; sigo con esto cuando termine (${n}º en la fila).`]),
  );
  assert.ok(f.reactions.includes("200.9:hourglass_flowing_sand"));

  for (const [i, dispatch] of ["dc1", "dc2", "dc3", "dc4"].entries()) {
    await processBatch(f.deps, [done(`m${i}`, dispatch)]);
    await Promise.all(runs.splice(0));
  }

  assert.deepEqual(requests(f), [undefined, `/contenido aprobar ${ID} por Salva`, "/contenido rechazar otro por Facu", `/contenido cambiar ${ID} por Salva: otra foto`]);
  assert.equal(f.store.data.contentQueues[dir], undefined);
});

test("the content state and the queue survive a restart: buttons keep working and a free directory starts the queue's head", async () => {
  const { f, dir, drop, sweep } = setup();
  const path = join(mkdtempSync(join(tmpdir(), "content-state-")), "state.json");
  f.deps.store = openStore(path);
  drop("p1.json", proposal(dir));
  drop("cal.json", calendar);
  await sweep();
  await handleMention(f.deps, { channel: CH, threadTs: "300.1", ts: "300.1", user: "U1", text: "armá el calendario" });
  const [cal, post] = f.tops;
  await click(f, cal.blocks, "Aprobar", "U1", cal.ts);
  assert.deepEqual(f.deps.store.data.contentQueues[dir].map((q) => q.action.kind), ["calendario-aprobado"]);

  // Restart: the running job ended meanwhile, so the directory is free.
  const reopened = openStore(path);
  reopened.data.jobs[`${CH}:300.1`] = { ...reopened.data.jobs[`${CH}:300.1`], state: { kind: "cancelled" } };
  f.deps.store = reopened;
  await drainContent(f.deps, dir);
  assert.deepEqual(requests(f).slice(1), ["/contenido calendario-aprobado 2026-W43 por Facu"]);
  assert.equal(f.deps.store.data.contentQueues[dir], undefined);

  await processBatch(f.deps, [done("m1", "dc2")]);
  await click(f, post.blocks, "Aprobar", SALVA, post.ts);
  assert.deepEqual(requests(f).slice(2), [`/contenido aprobar ${ID} por Salva`]);
});

test("a mention in a bound directory busy with a content action keeps the usual busy reply", async () => {
  const { f, dir, drop, sweep } = setup();
  drop("p1.json", proposal(dir));
  await sweep();
  await click(f, f.tops[0].blocks, "Aprobar", "U1", "200.1");

  await handleMention(f.deps, { channel: CH, threadTs: "300.1", ts: "300.1", user: "U1", text: "armá el calendario" });

  assert.equal(f.posts.at(-1), `estoy con otro pedido en mkt (https://slack.test/${CH}/200.1); avisame cuando termine`);
  assert.equal(f.specs.length, 1);
  assert.deepEqual(f.store.data.contentQueues, {});
});
