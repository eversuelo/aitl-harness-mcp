import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EditFileTool } from "./filesystem.js";

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "aitl-fs-"));
  const path = join(dir, "sample.txt");
  await fs.writeFile(path, content, "utf-8");
  return path;
}

test("edit_file replaces a unique substring in place", async () => {
  const path = await tmpFile("const speed = 5;\nconst lives = 3;\n");
  const out = await new EditFileTool().run({
    path,
    old_string: "const speed = 5;",
    new_string: "const speed = 8;",
  });
  assert.match(out, /replaced 1 occurrence$/);
  assert.equal(await fs.readFile(path, "utf-8"), "const speed = 8;\nconst lives = 3;\n");
});

test("edit_file rejects an ambiguous match unless replace_all", async () => {
  const path = await tmpFile("x = 1;\nx = 1;\n");
  const tool = new EditFileTool();
  await assert.rejects(
    () => tool.run({ path, old_string: "x = 1;", new_string: "x = 2;" }),
    /matches 2 places/,
  );
  const out = await tool.run({ path, old_string: "x = 1;", new_string: "x = 2;", replace_all: true });
  assert.match(out, /replaced 2 occurrences$/);
  assert.equal(await fs.readFile(path, "utf-8"), "x = 2;\nx = 2;\n");
});

test("edit_file rejects a stale old_string and identical strings", async () => {
  const path = await tmpFile("hello\n");
  const tool = new EditFileTool();
  await assert.rejects(() => tool.run({ path, old_string: "goodbye", new_string: "bye" }), /not found/);
  await assert.rejects(() => tool.run({ path, old_string: "hello", new_string: "hello" }), /identical/);
  await assert.rejects(() => tool.run({ path, old_string: "", new_string: "x" }), /non-empty/);
});
