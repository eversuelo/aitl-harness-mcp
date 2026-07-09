import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendHistory, expandFileMentions, historyFile, loadHistory } from "./history.js";

const tmpDir = () => fs.mkdtemp(join(tmpdir(), "aitl-repl-"));

test("historyFile: project name is sanitized into the filename", () => {
  const p = historyFile("aitl js/rara", "/base");
  assert.equal(p, "/base/chat-aitl-js-rara.txt");
});

test("history: append → load round-trips newest-first and skips consecutive dups", async () => {
  const path = join(await tmpDir(), "h.txt");
  await appendHistory(path, "uno");
  await appendHistory(path, "dos\ncon salto");
  await appendHistory(path, "dos con salto"); // consecutive dup after flattening
  const loaded = await loadHistory(path);
  assert.deepEqual(loaded, ["dos con salto", "uno"]);
});

test("history: load of a missing file is empty, append never throws", async () => {
  const path = join(await tmpDir(), "nope", "h.txt");
  assert.deepEqual(await loadHistory(path), []);
  await appendHistory(path, "primera");
  assert.deepEqual(await loadHistory(path), ["primera"]);
});

test("mentions: existing files are inlined as fenced context blocks", async () => {
  const dir = await tmpDir();
  await fs.writeFile(join(dir, "nota.md"), "# hola\n", "utf-8");
  const { prompt, attached } = await expandFileMentions("resume @nota.md por favor", dir);
  assert.deepEqual(attached, ["nota.md"]);
  assert.ok(prompt.includes("--- file: nota.md ---"));
  assert.ok(prompt.includes("# hola"));
  assert.ok(prompt.startsWith("resume @nota.md por favor"), "the original text survives untouched");
});

test("mentions: non-files stay literal (emails, unknown paths)", async () => {
  const dir = await tmpDir();
  const input = "escribe a user@host.com sobre @no-existe.txt";
  const { prompt, attached } = await expandFileMentions(input, dir);
  assert.equal(prompt, input);
  assert.deepEqual(attached, []);
});

test("mentions: oversized files are clipped and flagged", async () => {
  const dir = await tmpDir();
  await fs.writeFile(join(dir, "fat.txt"), "x".repeat(60_000), "utf-8");
  const { prompt, attached } = await expandFileMentions("@fat.txt", dir);
  assert.deepEqual(attached, ["fat.txt"]);
  assert.ok(prompt.includes("(truncado)"));
  assert.ok(prompt.length < 60_000);
});
