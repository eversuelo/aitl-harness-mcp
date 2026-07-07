import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateEnvFile } from "./envfile.js";

/** Fresh temp dir per test; returns the .env path and a cleanup fn. */
async function tmpEnv(content?: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "aitl-envfile-"));
  const path = join(dir, ".env");
  if (content !== undefined) await writeFile(path, content, "utf-8");
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("updateEnvFile replaces an existing KEY= line in place", async () => {
  const { path, cleanup } = await tmpEnv("A=1\nMODEL_PRIMARY=openrouter\nB=2\n");
  try {
    await updateEnvFile(path, { MODEL_PRIMARY: "lmstudio" });
    assert.equal(await readFile(path, "utf-8"), "A=1\nMODEL_PRIMARY=lmstudio\nB=2\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile uncomments a `# KEY=...` line when no active line exists", async () => {
  const { path, cleanup } = await tmpEnv("# header comment\n# MODEL_PRIMARY=old-value\nA=1\n");
  try {
    await updateEnvFile(path, { MODEL_PRIMARY: "anthropic" });
    assert.equal(await readFile(path, "utf-8"), "# header comment\nMODEL_PRIMARY=anthropic\nA=1\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile prefers the active line over a commented duplicate", async () => {
  const { path, cleanup } = await tmpEnv("# KEY=commented\nKEY=active\n");
  try {
    await updateEnvFile(path, { KEY: "new" });
    // The active line is replaced; the commented one stays untouched.
    assert.equal(await readFile(path, "utf-8"), "# KEY=commented\nKEY=new\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile appends absent keys at the end", async () => {
  const { path, cleanup } = await tmpEnv("A=1\n");
  try {
    await updateEnvFile(path, { NEW_KEY: "value", OTHER: "x y z" });
    assert.equal(await readFile(path, "utf-8"), "A=1\nNEW_KEY=value\nOTHER=x y z\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile with null comments the line out and drops the old value", async () => {
  const { path, cleanup } = await tmpEnv("A=1\nSECRET_KEY=super-secret\nB=2\n");
  try {
    await updateEnvFile(path, { SECRET_KEY: null });
    const content = await readFile(path, "utf-8");
    assert.equal(content, "A=1\n# SECRET_KEY=\nB=2\n");
    assert.ok(!content.includes("super-secret"), "the old secret must not linger in a comment");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile with null on an absent key is a no-op", async () => {
  const original = "# a comment\nA=1\n\nB=2\n";
  const { path, cleanup } = await tmpEnv(original);
  try {
    await updateEnvFile(path, { MISSING: null });
    assert.equal(await readFile(path, "utf-8"), original);
  } finally {
    await cleanup();
  }
});

test("updateEnvFile preserves comments, blank lines, order and foreign lines", async () => {
  const original = [
    "# MongoDB",
    "MONGODB_URI=mongodb://localhost",
    "",
    "# unrelated tool section",
    "SOME_OTHER_TOOL_VAR=keep-me",
    "  INDENTED=also kept",
    "MODEL_PRIMARY=openrouter",
    "",
  ].join("\n");
  const { path, cleanup } = await tmpEnv(original);
  try {
    await updateEnvFile(path, { MODEL_PRIMARY: "lmstudio" });
    assert.equal(
      await readFile(path, "utf-8"),
      [
        "# MongoDB",
        "MONGODB_URI=mongodb://localhost",
        "",
        "# unrelated tool section",
        "SOME_OTHER_TOOL_VAR=keep-me",
        "  INDENTED=also kept",
        "MODEL_PRIMARY=lmstudio",
        "",
      ].join("\n"),
    );
  } finally {
    await cleanup();
  }
});

test("updateEnvFile creates the file when missing", async () => {
  const { path, cleanup } = await tmpEnv(); // no file written
  try {
    await updateEnvFile(path, { A: "1", B: "two" });
    assert.equal(await readFile(path, "utf-8"), "A=1\nB=two\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile replaces every duplicate active line", async () => {
  const { path, cleanup } = await tmpEnv("K=first\nA=1\nK=second\n");
  try {
    await updateEnvFile(path, { K: "final" });
    assert.equal(await readFile(path, "utf-8"), "K=final\nA=1\nK=final\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile does not touch keys that merely share a prefix", async () => {
  const { path, cleanup } = await tmpEnv("MODEL_PRIMARY=keep\nMODEL=old\n");
  try {
    await updateEnvFile(path, { MODEL: "new" });
    assert.equal(await readFile(path, "utf-8"), "MODEL_PRIMARY=keep\nMODEL=new\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile applies mixed set/unset updates in one call", async () => {
  const { path, cleanup } = await tmpEnv("A=1\n# B=commented\nC=3\n");
  try {
    await updateEnvFile(path, { A: "10", B: "20", C: null, D: "40" });
    assert.equal(await readFile(path, "utf-8"), "A=10\nB=20\n# C=\nD=40\n");
  } finally {
    await cleanup();
  }
});

test("updateEnvFile normalizes a file without a trailing newline", async () => {
  const { path, cleanup } = await tmpEnv("A=1"); // no trailing \n
  try {
    await updateEnvFile(path, { B: "2" });
    assert.equal(await readFile(path, "utf-8"), "A=1\nB=2\n");
  } finally {
    await cleanup();
  }
});
