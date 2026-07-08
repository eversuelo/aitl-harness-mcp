import assert from "node:assert/strict";
import { test } from "node:test";
import { RESTART_EXIT_CODE, missingCoreCollections, shouldRespawn } from "./ui.js";

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
