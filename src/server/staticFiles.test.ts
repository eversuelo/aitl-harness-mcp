import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveStaticFile } from "./staticFiles.js";

function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), "aitl-static-"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  return root;
}

test("resolveStaticFile serves real files with their mime type", () => {
  const root = makeDist();
  const hit = resolveStaticFile(root, "/assets/app-abc123.js");
  assert.ok(hit);
  assert.ok(hit.file.endsWith("app-abc123.js"));
  assert.equal(hit.type, "text/javascript; charset=utf-8");
  assert.equal(hit.immutable, true);
});

test("resolveStaticFile falls back to index.html for SPA routes", () => {
  const root = makeDist();
  const hit = resolveStaticFile(root, "/workspace/some/route");
  assert.ok(hit);
  assert.ok(hit.file.endsWith("index.html"));
  assert.equal(hit.immutable, false);
});

test("resolveStaticFile blocks path traversal", () => {
  const root = makeDist();
  const hit = resolveStaticFile(root, "/../../../etc/passwd");
  assert.ok(hit);
  assert.ok(hit.file.endsWith("index.html"), "traversal must resolve to the SPA fallback");
  const encoded = resolveStaticFile(root, "/%2e%2e/%2e%2e/etc/passwd");
  assert.ok(encoded);
  assert.ok(encoded.file.endsWith("index.html"));
});

test("resolveStaticFile returns null without an index.html", () => {
  const empty = mkdtempSync(join(tmpdir(), "aitl-static-empty-"));
  assert.equal(resolveStaticFile(empty, "/anything"), null);
});
