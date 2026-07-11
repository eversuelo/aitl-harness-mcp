import assert from "node:assert/strict";
import { test } from "node:test";
import type { ADR } from "../models/decision.model.js";
import {
  adrGuardHook,
  checkPathAgainstAdrs,
  pathToComponentDir,
  renderGuardWarning,
} from "./adrGuard.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeAdr(overrides: Partial<ADR> & { id: string; components: string[] }): ADR {
  const { id, components, ...rest } = overrides;
  return {
    project: "test",
    created_at: new Date(),
    updated_at: new Date(),
    title: `ADR-${id}`,
    context: "",
    decision: "Do the thing.",
    consequences: "",
    status: "accepted",
    deprecation_reason: null,
    superseded_by: null,
    review_after: null,
    model: null,
    trigger: null,
    git_ref: null,
    version: 1,
    actor_id: null,
    actor_role: null,
    branch: null,
    commit_sha: null,
    embedding: null,
    ...rest,
    id,
    components,
  } as ADR;
}

// ── pathToComponentDir ──────────────────────────────────────────────────────

test("pathToComponentDir: extracts parent dir from a file path", () => {
  assert.equal(pathToComponentDir("src/server/routes/api.ts"), "src/server/routes");
});

test("pathToComponentDir: root file returns empty string", () => {
  assert.equal(pathToComponentDir("README.md"), "");
});

test("pathToComponentDir: normalises backslashes", () => {
  assert.equal(pathToComponentDir("src\\tools\\base.ts"), "src/tools");
});

test("pathToComponentDir: strips leading ./", () => {
  assert.equal(pathToComponentDir("./src/cli.ts"), "src");
});

// ── checkPathAgainstAdrs ────────────────────────────────────────────────────

test("checkPathAgainstAdrs: matches ADR whose component is an ancestor of the file dir", () => {
  const adrs = [fakeAdr({ id: "0019", components: ["src/providers"], title: "OpenAI gateway" })];
  const result = checkPathAgainstAdrs("src/providers/openai.ts", adrs);
  assert.equal(result.adrs.length, 1);
  assert.equal(result.adrs[0].adrId, "0019");
});

test("checkPathAgainstAdrs: matches ADR whose component is a subdir of the file dir", () => {
  const adrs = [fakeAdr({ id: "0005", components: ["src/providers/openai"] })];
  const result = checkPathAgainstAdrs("src/providers/index.ts", adrs);
  assert.equal(result.adrs.length, 1);
  assert.equal(result.adrs[0].adrId, "0005");
});

test("checkPathAgainstAdrs: exact component match", () => {
  const adrs = [fakeAdr({ id: "0010", components: ["src/tools"] })];
  const result = checkPathAgainstAdrs("src/tools/base.ts", adrs);
  assert.equal(result.adrs.length, 1);
});

test("checkPathAgainstAdrs: no match for unrelated component", () => {
  const adrs = [fakeAdr({ id: "0010", components: ["src/tools"] })];
  const result = checkPathAgainstAdrs("src/repl/chat.ts", adrs);
  assert.equal(result.adrs.length, 0);
});

test("checkPathAgainstAdrs: skips deprecated ADRs", () => {
  const adrs = [fakeAdr({ id: "0010", components: ["src/tools"], status: "deprecated" })];
  const result = checkPathAgainstAdrs("src/tools/base.ts", adrs);
  assert.equal(result.adrs.length, 0);
});

test("checkPathAgainstAdrs: skips superseded ADRs", () => {
  const adrs = [fakeAdr({ id: "0010", components: ["src/tools"], status: "superseded" })];
  const result = checkPathAgainstAdrs("src/tools/base.ts", adrs);
  assert.equal(result.adrs.length, 0);
});

test("checkPathAgainstAdrs: multiple ADRs for the same component", () => {
  const adrs = [
    fakeAdr({ id: "0019", components: ["src/providers"] }),
    fakeAdr({ id: "0020", components: ["src/providers"] }),
    fakeAdr({ id: "0099", components: ["src/memory"] }),
  ];
  const result = checkPathAgainstAdrs("src/providers/anthropic.ts", adrs);
  assert.equal(result.adrs.length, 2);
  assert.deepEqual(
    result.adrs.map((a) => a.adrId),
    ["0019", "0020"],
  );
});

test("checkPathAgainstAdrs: ADRs with no components are skipped", () => {
  const adrs = [fakeAdr({ id: "0001", components: [] })];
  const result = checkPathAgainstAdrs("src/cli.ts", adrs);
  assert.equal(result.adrs.length, 0);
});

test("checkPathAgainstAdrs: root-level file with no dir returns empty", () => {
  const adrs = [fakeAdr({ id: "0001", components: ["src"] })];
  const result = checkPathAgainstAdrs("package.json", adrs);
  assert.equal(result.adrs.length, 0);
});

// ── renderGuardWarning ──────────────────────────────────────────────────────

test("renderGuardWarning: empty when no ADRs match", () => {
  const result = renderGuardWarning([{ path: "x.ts", dir: "src", adrs: [] }]);
  assert.equal(result, "");
});

test("renderGuardWarning: includes ADR id and title", () => {
  const result = renderGuardWarning([
    {
      path: "src/providers/foo.ts",
      dir: "src/providers",
      adrs: [{ adrId: "0019", title: "OpenAI gateway", decision: "Use one gateway", components: ["src/providers"] }],
    },
  ]);
  assert.ok(result.includes("ADR-0019"));
  assert.ok(result.includes("OpenAI gateway"));
  assert.ok(result.includes("Use one gateway"));
  assert.ok(result.includes("⚠"));
});

// ── adrGuardHook (integration-style with injected loadAdrs) ────────────────

test("adrGuardHook: annotates write_file result with matching ADRs", async () => {
  const adrs = [
    fakeAdr({ id: "0019", components: ["src/providers"], title: "OpenAI gateway", decision: "Reuse provider" }),
  ];
  const hook = adrGuardHook({
    project: "test",
    root: "/repo",
    loadAdrs: async () => adrs,
  });

  const out = await hook("write_file", { path: "/repo/src/providers/new.ts" }, "wrote 100 chars");
  assert.ok(out != null);
  const result = (out as { result: string }).result;
  assert.ok(result.startsWith("wrote 100 chars"));
  assert.ok(result.includes("ADR-0019"));
  assert.ok(result.includes("Reuse provider"));
});

test("adrGuardHook: no-op for read_file", async () => {
  const hook = adrGuardHook({ project: "test", loadAdrs: async () => [] });
  const out = await hook("read_file", { path: "src/cli.ts" }, "file content");
  assert.equal(out, undefined);
});

test("adrGuardHook: no-op when no ADRs match", async () => {
  const adrs = [fakeAdr({ id: "0019", components: ["src/providers"] })];
  const hook = adrGuardHook({ project: "test", root: "/repo", loadAdrs: async () => adrs });
  const out = await hook("edit_file", { path: "/repo/src/repl/chat.ts" }, "edited");
  assert.equal(out, undefined);
});

test("adrGuardHook: degrades silently when loadAdrs throws", async () => {
  const hook = adrGuardHook({
    project: "test",
    loadAdrs: async () => {
      throw new Error("Mongo is down");
    },
  });
  const out = await hook("write_file", { path: "src/providers/x.ts" }, "wrote");
  // Should not throw; returns undefined (no annotation).
  assert.equal(out, undefined);
});

test("adrGuardHook: caches ADRs across calls", async () => {
  let calls = 0;
  const adrs = [fakeAdr({ id: "0019", components: ["src/providers"] })];
  const hook = adrGuardHook({
    project: "test",
    root: "/repo",
    loadAdrs: async () => {
      calls++;
      return adrs;
    },
  });

  await hook("write_file", { path: "/repo/src/providers/a.ts" }, "wrote");
  await hook("write_file", { path: "/repo/src/providers/b.ts" }, "wrote");
  assert.equal(calls, 1, "loadAdrs should only be called once thanks to caching");
});

test("adrGuardHook: handles relative path correctly", async () => {
  const adrs = [fakeAdr({ id: "0010", components: ["src/tools"], decision: "Keep tools simple" })];
  const hook = adrGuardHook({
    project: "test",
    root: "/repo",
    loadAdrs: async () => adrs,
  });

  // Path is already relative
  const out = await hook("edit_file", { path: "src/tools/shell.ts" }, "edited");
  assert.ok(out != null);
  assert.ok((out as { result: string }).result.includes("ADR-0010"));
});
