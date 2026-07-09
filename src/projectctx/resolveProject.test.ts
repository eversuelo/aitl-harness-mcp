import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { findProjectFile, resolveProject, writeProjectFile } from "./resolveProject.js";

const tmp = () => mkdtemp(join(tmpdir(), "aitl-proj-"));

describe("resolveProject", () => {
  it("explicit flag wins over everything", async () => {
    const dir = await tmp();
    writeProjectFile(dir, "from-file");
    const r = resolveProject("from-flag", { cwd: dir, env: { AITL_PROJECT: "from-env" } });
    assert.deepEqual([r.project, r.source], ["from-flag", "flag"]);
  });

  it("env wins over the marker file", async () => {
    const dir = await tmp();
    writeProjectFile(dir, "from-file");
    const r = resolveProject(undefined, { cwd: dir, env: { AITL_PROJECT: "from-env" } });
    assert.deepEqual([r.project, r.source], ["from-env", "env"]);
  });

  it("reads .aitl/project.json and reports its path", async () => {
    const dir = await tmp();
    const path = writeProjectFile(dir, "aitl-js");
    const r = resolveProject(undefined, { cwd: dir, env: {} });
    assert.deepEqual([r.project, r.source, r.file], ["aitl-js", "file", path]);
  });

  it("walks UP from a subdirectory to the repo's marker (the ADR-0055 trap)", async () => {
    const dir = await tmp();
    writeProjectFile(dir, "aitl-js");
    const sub = join(dir, "src", "deep");
    await mkdir(sub, { recursive: true });
    const r = resolveProject(undefined, { cwd: sub, env: {} });
    assert.equal(r.project, "aitl-js");
    assert.equal(r.source, "file");
  });

  it("falls back to the basename WITH a warning when nothing else resolves", async () => {
    const dir = await tmp();
    let warned = "";
    const r = resolveProject(undefined, { cwd: dir, env: {}, warn: (m) => (warned = m) });
    assert.deepEqual([r.project, r.source], [basename(dir), "basename"]);
    assert.match(warned, /scope VACÍO/);
  });

  it("skips a corrupt marker and keeps walking", async () => {
    const dir = await tmp();
    writeProjectFile(dir, "root-key");
    const sub = join(dir, "child");
    await mkdir(join(sub, ".aitl"), { recursive: true });
    await writeFile(join(sub, ".aitl", "project.json"), "{not json");
    const r = resolveProject(undefined, { cwd: sub, env: {} });
    assert.equal(r.project, "root-key");
  });

  it("findProjectFile returns null on a bare tree", async () => {
    assert.equal(findProjectFile(await tmp()), null);
  });
});
