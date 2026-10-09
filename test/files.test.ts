import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFiles, messageFiles, outboxFiles, sanitizeName, selectFiles, withFiles } from "../src/files.ts";

const png = { id: "F1", name: "captura.png", mimetype: "image/png", size: 1200, url_private_download: "https://files.slack.com/F1/download", url_private: "https://files.slack.com/F1" };

test("selection keeps downloadable files and says why it skipped the rest", () => {
  const raw = messageFiles([
    { files: [png, { id: "F2", name: "doc", mode: "external", url_private: "https://docs.google.com/x" }] },
    { files: [{ id: "F3", file_access: "check_file_info" }, { id: "F4", name: "video.mov", size: 51 * 1024 * 1024, url_private: "u4" }] },
    { files: [{ id: "F5", name: "notas.txt", url_private: "https://files.slack.com/F5" }, { id: "F6", name: "borrado", mode: "tombstone" }, png] },
    { text: "sin archivos" },
  ]);

  const { files, skipped } = selectFiles(raw);

  assert.deepEqual(files, [
    { id: "F1", name: "captura.png", mimetype: "image/png", size: 1200, url: "https://files.slack.com/F1/download" },
    { id: "F5", name: "notas.txt", mimetype: "application/octet-stream", size: 0, url: "https://files.slack.com/F5" },
  ]);
  assert.deepEqual(
    skipped.map((s) => s.name),
    ["doc", "F3", "video.mov", "borrado"],
  );
  assert.match(skipped[2].reason, /50 MB/);
});

test("sanitized names are one safe path segment", () => {
  for (const evil of ["../../etc/passwd", "a/b\\c.png", "..", ".env", "x/../../y"]) {
    const safe = sanitizeName(evil);
    assert.ok(!safe.includes("/") && !safe.includes("\\") && !safe.includes("..") && !safe.startsWith("."), `${evil} → ${safe}`);
    assert.ok(safe.length > 0);
  }
  assert.equal(sanitizeName("Captura de pantalla 2026.png"), "Captura_de_pantalla_2026.png");
  assert.equal(sanitizeName(`${"a".repeat(300)}.pdf`).length, 100);
  assert.ok(sanitizeName(`${"a".repeat(300)}.pdf`).endsWith(".pdf"));
});

function slackFile(over: Partial<{ id: string; name: string; mimetype: string }> = {}) {
  return { id: "F1", name: "captura.png", mimetype: "image/png", size: 4, url: "https://files.slack.com/F1/download", ...over };
}

test("a download writes the bytes under <id>-<name>; a file already on disk is not fetched again", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "files-")), "in");
  const fetched: string[] = [];
  const fetchFile = async (url: string) => {
    fetched.push(url);
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/png" } });
  };

  const first = await downloadFiles(dir, [slackFile()], fetchFile);
  const again = await downloadFiles(dir, [slackFile()], fetchFile);

  assert.deepEqual(first, { files: [{ path: join(dir, "F1-captura.png"), name: "captura.png", mimetype: "image/png", fresh: true }], failed: [] });
  assert.deepEqual(again.files.map((f) => f.fresh), [false]);
  assert.deepEqual(fetched, ["https://files.slack.com/F1/download"]);
  assert.deepEqual([...(await readFile(join(dir, "F1-captura.png")))], [1, 2, 3, 4]);
  assert.deepEqual(await readdir(dir), ["F1-captura.png"]);
});

test("an HTML login page instead of the file is an error naming files:read, and the other files still download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-"));
  const fetchFile = async (url: string) =>
    url.endsWith("F1")
      ? new Response("<html>login</html>", { headers: { "content-type": "text/html; charset=utf-8" } })
      : url.endsWith("F2")
        ? new Response("x", { status: 500 })
        : new Response("hola", { headers: { "content-type": "text/plain" } });

  const files = [slackFile({ id: "F1" }), slackFile({ id: "F2" }), slackFile({ id: "F3", name: "a.txt", mimetype: "text/plain" })].map((f) => ({ ...f, url: `u/${f.id}` }));

  const res = await downloadFiles(dir, files, fetchFile);

  assert.equal(res.failed.length, 2);
  assert.match(res.failed[0].reason, /files:read/);
  assert.match(res.failed[1].reason, /HTTP 500/);
  assert.deepEqual(res.files.map((f) => f.name), ["a.txt"]);
  assert.deepEqual(await readdir(dir), ["F3-a.txt"], "a rejected page leaves nothing on disk");
});

test("an HTML file the user really sent is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-"));
  const res = await downloadFiles(dir, [slackFile({ name: "page.html", mimetype: "text/html" })], async () => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }));
  assert.deepEqual(res.failed, []);
});

test("a message for the worker names each file's path even with no text", () => {
  const files = [{ path: "/data/files/C1-100-1/in/F1-captura.png", name: "captura.png", mimetype: "image/png", fresh: true }];
  assert.equal(withFiles("", files), "Files attached in Slack (inspect them with the Read tool):\n- /data/files/C1-100-1/in/F1-captura.png (captura.png, image/png)");
  assert.match(withFiles("usá esta", files), /^usá esta\n\nFiles attached/);
  assert.equal(withFiles("solo texto", []), "solo texto");
});

test("the outbox lists plain files by name and leaves dotfiles, folders and sent files alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "out-"));
  await writeFile(join(dir, "b.png"), "b");
  await writeFile(join(dir, "a.csv"), "a");
  await writeFile(join(dir, ".secret"), "s");
  await mkdir(join(dir, "sent"));
  await writeFile(join(dir, "sent", "old.png"), "o");

  assert.deepEqual(await outboxFiles(dir), { ready: [join(dir, "a.csv"), join(dir, "b.png")], tooBig: [] });
  assert.deepEqual(await outboxFiles(join(dir, "missing")), { ready: [], tooBig: [] });
});
