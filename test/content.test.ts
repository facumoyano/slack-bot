import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClick } from "../src/blocks.ts";
import { contentMessage, contentPrompt, readManifest } from "../src/content.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const CH = "CMKT0001";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "content-"));
  const dir = join(base, "mkt");
  mkdirSync(join(dir, "img"), { recursive: true });
  writeFileSync(join(dir, "img", "a.png"), PNG);
  writeFileSync(join(dir, "img", "b.jpg"), JPG);
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, "notas.txt"), "hola");
  writeFileSync(join(dir, "img", "fake.png"), "not an image");
  writeFileSync(join(base, "outside.png"), PNG);
  const dirs = { [CH]: { name: "mkt", path: dir } };
  return { base, dir, dirs };
}

function proposal(over: Record<string, unknown> = {}) {
  return {
    tipo: "propuesta",
    id: "2026-10-21-instagram",
    version: 1,
    canal: CH,
    red: "instagram",
    fecha: "2026-10-21",
    hora: "12:30",
    titulo: "Lanzamiento",
    texto: "Llega **Fyso**.\nProbalo gratis.",
    imagenes: [],
    archivo: "contenido/2026-10-21-instagram.md",
    buffer_id: "buf-1",
    ...over,
  };
}

test("a valid propuesta keeps every field and resolves its images, relative or absolute, to real paths in the bound directory", async () => {
  const { dir, dirs } = setup();
  const read = await readManifest(proposal({ imagenes: [join(dir, "img", "a.png"), "img/b.jpg"], notas: "ojo con el horario" }), dirs);
  assert.ok("manifest" in read, JSON.stringify(read));
  assert.deepEqual(read.manifest, { ...proposal(), notas: "ojo con el horario", imagenes: [join(dir, "img", "a.png"), join(dir, "img", "b.jpg")] });
});

test("a valid calendario needs no images", async () => {
  const { dirs } = setup();
  const raw = { tipo: "calendario", id: "2026-W43", version: 2, canal: CH, titulo: "Semana 43", texto: "- lunes: reel", archivo: "estrategia/calendario.json" };
  assert.deepEqual(await readManifest(raw, dirs), { manifest: raw });
});

test("missing or malformed fields are named in the error", async () => {
  const { dirs } = setup();
  const { titulo: _t, buffer_id: _b, ...rest } = proposal();
  assert.deepEqual(await readManifest({ ...rest, version: 0 }, dirs), { error: "faltan o están mal: `titulo`, `version`, `buffer_id`" });
  assert.deepEqual(await readManifest({ ...proposal(), tipo: "post" }, dirs), { error: '`tipo` tiene que ser "propuesta" o "calendario"' });
  assert.deepEqual(await readManifest("[]", dirs), { error: "no es un objeto JSON" });
  assert.match((await readManifest(proposal({ id: "../x" }), dirs) as { error: string }).error, /no es un slug/);
});

test("a channel that is not bound in ALFRED_DIRS is refused", async () => {
  const { dirs } = setup();
  assert.deepEqual(await readManifest(proposal({ canal: "COTHER01" }), dirs), { error: "el canal COTHER01 no está atado a una carpeta en ALFRED_DIRS" });
});

test("an image outside the bound directory is refused: absolute, through .., or through a symlink pointing out", async () => {
  const { base, dir, dirs } = setup();
  symlinkSync(join(base, "outside.png"), join(dir, "img", "link.png"));
  for (const path of [join(base, "outside.png"), "../outside.png", "img/../../outside.png", "img/link.png"]) {
    const read = await readManifest(proposal({ imagenes: [path] }), dirs);
    assert.deepEqual(read, { error: `la imagen \`${path}\` está fuera de la carpeta del canal` }, path);
  }
});

test("only real png, jpg, gif or webp images are accepted: .env, text and a disguised file are refused", async () => {
  const { dir, dirs } = setup();
  symlinkSync(join(dir, ".env"), join(dir, "img", "env.png"));
  assert.match((await readManifest(proposal({ imagenes: [".env"] }), dirs) as { error: string }).error, /no es una imagen/);
  assert.match((await readManifest(proposal({ imagenes: ["notas.txt"] }), dirs) as { error: string }).error, /no es una imagen/);
  assert.match((await readManifest(proposal({ imagenes: ["img/env.png"] }), dirs) as { error: string }).error, /no es una imagen/, "a symlink named .png to .env");
  assert.match((await readManifest(proposal({ imagenes: ["img/fake.png"] }), dirs) as { error: string }).error, /no tiene contenido de imagen/);
  assert.match((await readManifest(proposal({ imagenes: ["img/nope.png"] }), dirs) as { error: string }).error, /no existe/);
});

test("a propuesta message quotes the post as Slack text and carries Aprobar and Rechazar for that version; a calendario only Aprobar", () => {
  const msg = contentMessage({ ...proposal(), tipo: "propuesta", imagenes: [], notas: "subir a las 12" } as never);
  assert.equal(msg.text, "📣 *Lanzamiento*\n\n*Red:* instagram · *Fecha:* 2026-10-21 · *Hora:* 12:30\n\n> Llega *Fyso*.\n> Probalo gratis.\n\n*Notas:* subir a las 12\n\n_`2026-10-21-instagram` · versión 1_");
  const buttons = (msg.blocks ?? []).flatMap((b) => (b.type === "actions" ? b.elements : [])) as { action_id: string; value: string; style?: string; text: { text: string } }[];
  assert.deepEqual(buttons.map((b) => [b.text.text, b.style]), [["Aprobar", "primary"], ["Rechazar", "danger"]]);
  assert.deepEqual(parseClick(buttons[0].action_id, buttons[0].value), { kind: "content", key: "propuesta:2026-10-21-instagram", version: 1, decision: "approve" });
  assert.deepEqual(parseClick(buttons[1].action_id, buttons[1].value), { kind: "content", key: "propuesta:2026-10-21-instagram", version: 1, decision: "reject" });

  const cal = contentMessage({ tipo: "calendario", id: "2026-W43", version: 1, canal: CH, titulo: "Semana 43", texto: "## Lunes", archivo: "x" });
  const calButtons = (cal.blocks ?? []).flatMap((b) => (b.type === "actions" ? b.elements : [])) as { text: { text: string } }[];
  assert.deepEqual(calButtons.map((b) => b.text.text), ["Aprobar"]);
});

test("a forged content click value is rejected", () => {
  assert.equal(parseClick("alfred_content_approve", JSON.stringify({ k: "propuesta:../x", v: 1 })), undefined);
  assert.equal(parseClick("alfred_content_approve", JSON.stringify({ k: "post:x", v: 1 })), undefined);
  assert.equal(parseClick("alfred_content_approve", JSON.stringify({ k: "propuesta:x", v: 0 })), undefined);
});

test("each action is the literal /contenido request with who asked", () => {
  assert.equal(contentPrompt({ kind: "aprobar", id: "p1", by: "U1" }, "Salva"), "/contenido aprobar p1 por Salva");
  assert.equal(contentPrompt({ kind: "calendario-aprobado", id: "2026-W43", by: "U1" }, "Sebas"), "/contenido calendario-aprobado 2026-W43 por Sebas");
  assert.equal(contentPrompt({ kind: "cambiar", id: "p1", by: "U1", text: "más corto" }, "Salva"), "/contenido cambiar p1 por Salva: más corto");
});
