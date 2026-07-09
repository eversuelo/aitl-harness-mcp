import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LOOP_DEFAULTS,
  LoopSpecSchema,
  budgetBreached,
  isSpecPath,
  loadLoopSpecFile,
  loopSpecVersion,
  resolveLoopPolicy,
} from "./loopspec.js";

describe("LoopSpecSchema", () => {
  it("accepts a full policy", () => {
    const spec = LoopSpecSchema.parse({
      name: "thesis-c2",
      maxIters: 20,
      budgets: { tokens: 100_000, ms: 600_000 },
      stallThreshold: 2,
      maxVerifyRounds: 4,
      reflect: true,
      verifyCmd: "npm test",
    });
    assert.equal(spec.name, "thesis-c2");
  });

  it("rejects unknown fields (strict — a spec is a contract)", () => {
    assert.throws(() => LoopSpecSchema.parse({ name: "x", maxIterations: 5 }));
  });

  it("rejects a nameless spec", () => {
    assert.throws(() => LoopSpecSchema.parse({ maxIters: 5 }));
  });
});

describe("loopSpecVersion", () => {
  it("is deterministic and key-order independent", () => {
    const a = loopSpecVersion(LoopSpecSchema.parse({ name: "s", maxIters: 5, reflect: true }));
    const b = loopSpecVersion(LoopSpecSchema.parse({ reflect: true, maxIters: 5, name: "s" }));
    assert.equal(a, b);
    assert.equal(a.length, 12);
  });

  it("changes when any policy field changes", () => {
    const a = loopSpecVersion({ name: "s", maxIters: 5 });
    const b = loopSpecVersion({ name: "s", maxIters: 6 });
    assert.notEqual(a, b);
  });
});

describe("resolveLoopPolicy", () => {
  it("uses built-in defaults with no spec and no overrides", () => {
    const p = resolveLoopPolicy();
    assert.equal(p.maxIters, LOOP_DEFAULTS.maxIters);
    assert.equal(p.stallThreshold, LOOP_DEFAULTS.stallThreshold);
    assert.equal(p.maxVerifyRounds, LOOP_DEFAULTS.maxVerifyRounds);
    assert.equal(p.reflect, false);
    assert.equal(p.specRef, null);
  });

  it("spec beats defaults", () => {
    const p = resolveLoopPolicy({}, { name: "s", maxIters: 30, reflect: true });
    assert.equal(p.maxIters, 30);
    assert.equal(p.reflect, true);
  });

  it("explicit overrides beat the spec", () => {
    const p = resolveLoopPolicy(
      { maxIters: 3, stallThreshold: 0 },
      { name: "s", maxIters: 30, stallThreshold: 5 },
    );
    assert.equal(p.maxIters, 3);
    assert.equal(p.stallThreshold, 0);
  });

  it("carries the spec ref for harness_config stamping", () => {
    const ref = { name: "s", version: "abc123def456", source: "file" as const };
    assert.deepEqual(resolveLoopPolicy({}, { name: "s" }, ref).specRef, ref);
  });
});

describe("budgetBreached", () => {
  it("null without budgets", () => {
    assert.equal(budgetBreached(undefined, { tokens: 1e9, ms: 1e9 }), null);
  });

  it("flags the token budget at/over the limit", () => {
    assert.equal(budgetBreached({ tokens: 100 }, { tokens: 100, ms: 0 }), "tokens");
    assert.equal(budgetBreached({ tokens: 100 }, { tokens: 99, ms: 0 }), null);
  });

  it("flags the wall-clock budget", () => {
    assert.equal(budgetBreached({ ms: 60_000 }, { tokens: 0, ms: 60_001 }), "ms");
  });
});

describe("isSpecPath / loadLoopSpecFile", () => {
  it("classifies paths vs names", () => {
    assert.equal(isSpecPath("./loopspec.json"), true);
    assert.equal(isSpecPath("specs/loop.json"), true);
    assert.equal(isSpecPath("thesis-c2"), false);
  });

  it("loads and versions a spec file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopspec-"));
    const file = join(dir, "spec.json");
    await writeFile(file, JSON.stringify({ name: "file-spec", maxIters: 7 }));
    const { spec, ref } = await loadLoopSpecFile(file);
    assert.equal(spec.maxIters, 7);
    assert.equal(ref.source, "file");
    assert.equal(ref.version, loopSpecVersion(spec));
  });

  it("rejects an invalid spec file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopspec-"));
    const file = join(dir, "bad.json");
    await writeFile(file, JSON.stringify({ name: "bad", nope: 1 }));
    await assert.rejects(loadLoopSpecFile(file));
  });
});
