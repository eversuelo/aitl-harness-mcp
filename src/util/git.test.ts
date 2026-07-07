import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { headSha, resolveRef } from "./git.js";

// Tests run from the harness repo root, so process.cwd() is a real git repo with commits.

test("headSha returns the repo HEAD (full 40-hex sha)", () => {
  const sha = headSha();
  assert.ok(sha, "expected a sha inside the harness repo");
  assert.match(sha as string, /^[0-9a-f]{40}$/);
});

test("resolveRef('HEAD') matches headSha and unknown refs resolve to null", () => {
  assert.equal(resolveRef("HEAD"), headSha());
  assert.equal(resolveRef("definitely-not-a-ref-xyz"), null);
});

test("headSha/resolveRef return null outside a git repo (best-effort, never throw)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-git-test-"));
  try {
    assert.equal(headSha(dir), null);
    assert.equal(resolveRef("HEAD", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
