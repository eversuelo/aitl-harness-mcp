import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RESTART_EXIT_CODE, missingCoreCollections, resolveWebDir, shouldRespawn } from "./ui.js";

test("resolveWebDir: finds the SPA sources from both the source and dist layouts", () => {
  // Regression: it used to hardcode the source depth (`../../web`), so the compiled
  // binary got `dist/web` — a cwd that doesn't exist, which makes spawn report
  // ENOENT against `node` itself ("node is missing") instead of the real cause.
  const dir = resolveWebDir();
  assert.ok(dir, "web/ must resolve from a checkout (source or dist)");
  assert.ok(existsSync(join(dir, "vite.config.ts")));
  assert.ok(!dir.includes(`${join("dist", "web")}`), "must not point inside dist/");
});

test("shouldRespawn: only the restart exit code (75) respawns", () => {
  assert.equal(RESTART_EXIT_CODE, 75);
  assert.equal(shouldRespawn(RESTART_EXIT_CODE), true);
  assert.equal(shouldRespawn(0), false);
  assert.equal(shouldRespawn(1), false);
  assert.equal(shouldRespawn(null), false); // killed by signal
});

test("missingCoreCollections marks a virgin DB and nothing else", () => {
  // Fresh profile pointing at a brand-new database → everything is missing.
  assert.deepEqual(missingCoreCollections([]), ["users", "memory"]);
  // Partially created (e.g. only users bootstrapped) → still needs init.
  assert.deepEqual(missingCoreCollections(["users"]), ["memory"]);
  // Bootstrapped DB → nothing missing, initDb is skipped on boot.
  assert.deepEqual(missingCoreCollections(["users", "memory", "decisions", "runs"]), []);
});
