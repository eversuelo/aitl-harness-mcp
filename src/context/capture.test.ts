import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureSession, findLatestTranscript } from "./capture.js";

/**
 * DB-free tests for the session-capture guards (empty-run bug, 2026-07-12): a manual
 * `aitl capture-session` without transcript used to write a run of pure zeros. Now the
 * library throws before touching the store, and the CLI auto-discovers the newest
 * transcript for the cwd.
 */

test("captureSession without transcript throws instead of recording an empty run", async () => {
  await assert.rejects(
    () => captureSession({ project: "p" }),
    /no transcript to capture/,
  );
});

test("captureSession rejects a transcript that parses to zero turns/tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aitl-capture-"));
  try {
    const path = join(dir, "garbage.jsonl");
    await writeFile(path, `{"type":"summary"}\nnot json at all\n`);
    await assert.rejects(
      () => captureSession({ project: "p", transcriptPath: path }),
      /zero turns\/tokens/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findLatestTranscript picks the newest .jsonl in the cwd-slug dir (both slug variants)", async () => {
  const root = await mkdtemp(join(tmpdir(), "aitl-projects-"));
  try {
    const cwd = "/home/user/my.app/repo";
    // Claude Code slugs `/` (and on some versions `.`) to `-`; we probe both variants.
    const dir = join(root, "-home-user-my-app-repo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "old.jsonl"), "{}");
    await writeFile(join(dir, "new.jsonl"), "{}");
    await writeFile(join(dir, "ignored.txt"), "x");
    const past = new Date(Date.now() - 60_000);
    await utimes(join(dir, "old.jsonl"), past, past);

    const found = await findLatestTranscript(cwd, root);
    assert.equal(found, join(dir, "new.jsonl"));

    const missing = await findLatestTranscript("/somewhere/else", root);
    assert.equal(missing, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
