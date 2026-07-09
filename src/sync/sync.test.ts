import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ADR_CONTENT_FIELDS, MEMORY_CONTENT_FIELDS } from "../memory/versioning.js";
import { type ADR, makeADR } from "../models/decision.model.js";
import type { DefinitionKind, DefinitionRecord } from "../models/definition.model.js";
import { type MemoryDoc, makeMemoryDoc } from "../models/memory.model.js";
import { renderAdrMarkdown, renderMemoryMarkdown } from "./export.js";
import { loadSyncState } from "./state.js";
import { type SyncStores, syncProject } from "./sync.js";

/**
 * In-memory SyncStores over plain arrays (no Mongo, no embedder). Upserts mimic the
 * real versioning semantics: content change → version+1; identical → no-op version.
 */
function fakeStores(initial: { memory?: MemoryDoc[]; skills?: DefinitionRecord[]; agents?: DefinitionRecord[]; adrs?: ADR[] } = {}) {
  const memory = [...(initial.memory ?? [])];
  const defs: Record<DefinitionKind, DefinitionRecord[]> = {
    skill: [...(initial.skills ?? [])],
    agent: [...(initial.agents ?? [])],
    loop: [], // loop specs are not mirrored by sync (kind added for loop-engineering)
  };
  const adrs = [...(initial.adrs ?? [])];
  const FIXED = new Date("2026-07-06T12:00:00.000Z");

  const changed = (prev: Record<string, unknown> | null, next: Record<string, unknown>, fields: readonly string[]) =>
    !prev || fields.some((f) => JSON.stringify(prev[f] ?? null) !== JSON.stringify(next[f] ?? null));

  const stores: SyncStores = {
    async listMemory(project) {
      return memory.filter((d) => d.project === project);
    },
    async upsertMemory(doc) {
      const i = memory.findIndex((d) => d.project === doc.project && d.slug === doc.slug);
      const prev = i >= 0 ? (memory[i] as unknown as Record<string, unknown>) : null;
      const didChange = changed(prev, doc as unknown as Record<string, unknown>, MEMORY_CONTENT_FIELDS);
      doc.version = prev ? ((prev.version as number) ?? 1) + (didChange ? 1 : 0) : 1;
      doc.updated_at = FIXED;
      if (i >= 0) memory[i] = doc;
      else memory.push(doc);
      return doc;
    },
    async listDefinitions(kind, project) {
      return defs[kind].filter((d) => d.project === project);
    },
    async upsertDefinition(kind, rec) {
      const full = { description: "", content: "", tags: [], metadata: {}, source: "test", created_at: FIXED, ...rec, updated_at: FIXED } as DefinitionRecord;
      const i = defs[kind].findIndex((d) => d.project === rec.project && d.name === rec.name);
      if (i >= 0) defs[kind][i] = full;
      else defs[kind].push(full);
      return full;
    },
    async listAdrs(project) {
      return adrs.filter((a) => a.project === project);
    },
    async upsertAdr(adr) {
      const i = adrs.findIndex((a) => a.project === adr.project && a.id === adr.id);
      const prev = i >= 0 ? (adrs[i] as unknown as Record<string, unknown>) : null;
      const didChange = changed(prev, adr as unknown as Record<string, unknown>, ADR_CONTENT_FIELDS);
      adr.version = prev ? ((prev.version as number) ?? 1) + (didChange ? 1 : 0) : 1;
      if (i >= 0) adrs[i] = adr;
      else adrs.push(adr);
      return adr;
    },
  };
  return { stores, memory, defs, adrs };
}

const P = "p";

async function mkRoot() {
  const root = await fs.mkdtemp(join(tmpdir(), "aitl-sync-"));
  return { root, dir: join(root, ".aitl"), adrDir: join(root, "docs", "adr") };
}

const mkMem = (slug: string, body: string, extra: Partial<MemoryDoc> = {}) =>
  makeMemoryDoc({
    project: P,
    slug,
    body,
    description: `desc of ${slug}`,
    type: "project",
    version: 1,
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    ...extra,
  });

const mkAdr = (id: string, title: string, extra: Partial<ADR> = {}) =>
  makeADR({
    project: P,
    id,
    title,
    context: `context ${id}`,
    decision: `decision ${id}`,
    consequences: `consequences ${id}`,
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    ...extra,
  });

const syncOpts = (t: { dir: string; adrDir: string }, stores: SyncStores, extra: Record<string, unknown> = {}) => ({
  dir: t.dir,
  adrDir: t.adrDir,
  stores,
  branch: null,
  commit_sha: null,
  ...extra,
});

async function writeMemoryFile(dir: string, slug: string, body: string, extraFm = ""): Promise<string> {
  const path = join(dir, "memory", `${slug}.md`);
  await fs.mkdir(join(dir, "memory"), { recursive: true });
  await fs.writeFile(path, `---\nname: ${slug}\ntype: project\n${extraFm}---\n${body}`, "utf-8");
  return path;
}

// ── bootstrap: one side only → propagate ─────────────────────────────────────

test("sync: new-in-Mongo is pulled to disk, new-on-disk is pushed to Mongo; second run is a full no-op", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("from-mongo", "mongo body\n")] });
  await writeMemoryFile(t.dir, "from-disk", "disk body\n");

  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r1.pulled.map((i) => `${i.entity}:${i.key}`), ["memory:from-mongo"]);
  assert.deepEqual(r1.pushed.map((i) => `${i.entity}:${i.key}`), ["memory:from-disk"]);
  assert.equal(r1.conflicts.length, 0);
  // pulled file exists and is the canonical render
  const pulledPath = join(t.dir, "memory", "from-mongo.md");
  assert.equal(await fs.readFile(pulledPath, "utf-8"), renderMemoryMarkdown(memory[0]));
  // pushed doc landed in "Mongo" at version 1
  const pushed = memory.find((d) => d.slug === "from-disk");
  assert.equal(pushed?.body, "disk body\n");
  assert.equal(pushed?.version, 1);

  // idempotence
  const r2 = await syncProject(P, syncOpts(t, stores));
  assert.equal(r2.pulled.length + r2.pushed.length + r2.conflicts.length + r2.skipped.length, 0);
  assert.equal(r2.unchanged, 2);
});

// ── bootstrap: both sides, divergent bytes → baseline seeded, nothing written ─

test("sync bootstrap: divergent doc on both sides is NOT touched (baseline seeded); later runs stay no-op", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("x", "mongo body\n")] });
  const filePath = await writeMemoryFile(t.dir, "x", "handwritten disk body\n");
  const originalBytes = await fs.readFile(filePath, "utf-8");

  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.equal(r1.pulled.length, 0);
  assert.equal(r1.pushed.length, 0);
  assert.equal(r1.conflicts.length, 0);
  assert.equal(r1.skipped.length, 1);
  assert.match(r1.skipped[0].reason ?? "", /bootstrap/);
  assert.equal(await fs.readFile(filePath, "utf-8"), originalBytes, "file untouched");
  assert.equal(memory[0].body, "mongo body\n");
  assert.equal(memory[0].version, 1);

  // Even an explicit --pull on the NEXT run does not clobber: baseline says neither side changed.
  const r2 = await syncProject(P, syncOpts(t, stores, { mode: "pull" }));
  assert.equal(r2.pulled.length, 0);
  assert.equal(r2.unchanged, 1);
  assert.equal(await fs.readFile(filePath, "utf-8"), originalBytes);
});

// ── tracked changes: single-side edits propagate ─────────────────────────────

test("sync: mongo-only change is pulled; disk-only change is pushed with a version bump", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("doc", "v1 body\n")] });
  await syncProject(P, syncOpts(t, stores)); // baseline (pull creates the file)

  // Mongo-side edit → pull rewrites the file.
  memory[0] = await mkMem("doc", "v2 body from mongo\n", { version: 2, updated_at: new Date("2026-07-02T00:00:00.000Z") });
  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r1.pulled.map((i) => i.key), ["doc"]);
  const path = join(t.dir, "memory", "doc.md");
  assert.match(await fs.readFile(path, "utf-8"), /v2 body from mongo/);

  // Disk-side edit → push bumps the version in Mongo.
  const edited = (await fs.readFile(path, "utf-8")).replace("v2 body from mongo", "v3 body edited on disk");
  await fs.writeFile(path, edited, "utf-8");
  const r2 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r2.pushed.map((i) => i.key), ["doc"]);
  assert.equal(memory[0].body.trim(), "v3 body edited on disk");
  assert.equal(memory[0].version, 3);

  // Convergence: next run is a no-op.
  const r3 = await syncProject(P, syncOpts(t, stores));
  assert.equal(r3.pulled.length + r3.pushed.length + r3.conflicts.length, 0);
});

// ── conflicts ────────────────────────────────────────────────────────────────

test("sync: both sides changed → conflict reported, nothing touched; --pull lets Mongo win; --push lets disk win", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("c", "base body\n")] });
  await syncProject(P, syncOpts(t, stores)); // baseline
  const path = join(t.dir, "memory", "c.md");

  // Diverge both sides.
  memory[0] = await mkMem("c", "mongo wins body\n", { version: 2 });
  const diskEdit = (await fs.readFile(path, "utf-8")).replace("base body", "disk wins body");
  await fs.writeFile(path, diskEdit, "utf-8");

  // both → conflict, untouched.
  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r1.conflicts.map((i) => i.key), ["c"]);
  assert.equal(await fs.readFile(path, "utf-8"), diskEdit);
  assert.equal(memory[0].body, "mongo wins body\n");

  // --pull → Mongo wins on disk.
  const r2 = await syncProject(P, syncOpts(t, stores, { mode: "pull" }));
  assert.deepEqual(r2.pulled.map((i) => i.key), ["c"]);
  assert.match(await fs.readFile(path, "utf-8"), /mongo wins body/);

  // Diverge again, then --push → disk wins in Mongo.
  memory[0] = await mkMem("c", "mongo again\n", { version: 3 });
  const diskEdit2 = (await fs.readFile(path, "utf-8")).replace("mongo wins body", "disk final body");
  await fs.writeFile(path, diskEdit2, "utf-8");
  const r3 = await syncProject(P, syncOpts(t, stores, { mode: "push" }));
  assert.deepEqual(r3.pushed.map((i) => i.key), ["c"]);
  assert.equal(memory[0].body.trim(), "disk final body");
});

// ── deletions are never propagated ───────────────────────────────────────────

test("sync: deleted file is restored from Mongo; doc deleted in Mongo keeps its file (reported)", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("keep", "keep body\n"), await mkMem("gone", "gone body\n")] });
  await syncProject(P, syncOpts(t, stores)); // baseline

  // rm the mirror file → restored on the next run (disk is a mirror).
  const keepPath = join(t.dir, "memory", "keep.md");
  await fs.rm(keepPath);
  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.ok(r1.pulled.some((i) => i.key === "keep" && /restaurado/.test(i.reason ?? "")));
  assert.match(await fs.readFile(keepPath, "utf-8"), /keep body/);

  // delete the doc in Mongo → the file survives, reported as skipped.
  memory.splice(memory.findIndex((d) => d.slug === "gone"), 1);
  const r2 = await syncProject(P, syncOpts(t, stores));
  assert.ok(r2.skipped.some((i) => i.key === "gone" && /borrado en Mongo/.test(i.reason ?? "")));
  await fs.access(join(t.dir, "memory", "gone.md")); // still there
});

// ── mode filters on bootstrap ────────────────────────────────────────────────

test("sync --pull writes only what is missing on disk and never pushes; --push never writes to disk", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("m-only", "mongo only\n")] });
  await writeMemoryFile(t.dir, "d-only", "disk only\n");

  const r1 = await syncProject(P, syncOpts(t, stores, { mode: "pull" }));
  assert.deepEqual(r1.pulled.map((i) => i.key), ["m-only"]);
  assert.equal(r1.pushed.length, 0);
  assert.ok(r1.skipped.some((i) => i.key === "d-only" && /--pull/.test(i.reason ?? "")));
  assert.ok(!memory.some((d) => d.slug === "d-only"), "pull must not write to Mongo");

  const r2 = await syncProject(P, syncOpts(t, stores, { mode: "push" }));
  assert.deepEqual(r2.pushed.map((i) => i.key), ["d-only"]);
  assert.equal(r2.pulled.length, 0);
  assert.ok(memory.some((d) => d.slug === "d-only"));
});

// ── reserved memory types ────────────────────────────────────────────────────

test("sync: reserved types (spec/design/task/synthesis) are excluded unless includeReserved", async () => {
  const t = await mkRoot();
  const { stores } = fakeStores({
    memory: [await mkMem("normal", "normal\n"), await mkMem("pipeline-spec", "spec body\n", { type: "spec" })],
  });
  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r1.pulled.map((i) => i.key), ["normal"]);
  await assert.rejects(fs.access(join(t.dir, "memory", "pipeline-spec.md")));

  const r2 = await syncProject(P, syncOpts(t, stores, { includeReserved: true }));
  assert.deepEqual(r2.pulled.map((i) => i.key), ["pipeline-spec"]);
  await fs.access(join(t.dir, "memory", "pipeline-spec.md"));
});

// ── ADR bootstrap (the docs/adr backfill scenario) ───────────────────────────

test("sync ADRs: --pull backfills only MISSING files; handwritten divergent files stay byte-identical", async () => {
  const t = await mkRoot();
  const { stores } = fakeStores({
    adrs: [await mkAdr("0001", "First decision"), await mkAdr("0002", "Second decision")],
  });
  // 0001 exists handwritten with the SAME parsed content but different formatting.
  await fs.mkdir(t.adrDir, { recursive: true });
  const handwritten =
    "# ADR-0001 — First decision\n\n- **Status:** Accepted\n- **Date:** 2026-07-01\n\n" +
    "## Context\ncontext 0001\n\n## Decision\ndecision 0001\n\n## Consequences\nconsequences 0001\n";
  const path0001 = join(t.adrDir, "0001-first-decision.md");
  await fs.writeFile(path0001, handwritten, "utf-8");

  const r1 = await syncProject(P, syncOpts(t, stores, { mode: "pull" }));
  assert.deepEqual(r1.pulled.map((i) => i.key), ["0002"]); // only the absent one
  assert.equal(await fs.readFile(path0001, "utf-8"), handwritten, "handwritten ADR untouched");
  const backfilled = await fs.readFile(join(t.adrDir, "0002-second-decision.md"), "utf-8");
  assert.match(backfilled, /# ADR-0002 — Second decision/);

  const r2 = await syncProject(P, syncOpts(t, stores, { mode: "pull" }));
  assert.equal(r2.pulled.length, 0);
  assert.equal(r2.unchanged, 2);
});

test("sync ADRs: editing a tracked ADR file pushes lifecycle fields into Mongo with a version bump", async () => {
  const t = await mkRoot();
  const { stores, adrs } = fakeStores({ adrs: [await mkAdr("0003", "Third decision")] });
  await syncProject(P, syncOpts(t, stores)); // baseline pull writes the canonical file

  const path = join(t.adrDir, "0003-third-decision.md");
  const edited = (await fs.readFile(path, "utf-8"))
    .replace("- **Status:** accepted", "- **Status:** deprecated\n- **Deprecation-reason:** replaced by 0004\n- **Superseded-by:** 0004")
    .replace("decision 0003", "decision 0003 (amended)");
  await fs.writeFile(path, edited, "utf-8");

  const r = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r.pushed.map((i) => i.key), ["0003"]);
  const doc = adrs.find((a) => a.id === "0003");
  assert.equal(doc?.status, "deprecated");
  assert.equal(doc?.deprecation_reason, "replaced by 0004");
  assert.equal(doc?.superseded_by, "0004");
  assert.equal(doc?.decision, "decision 0003 (amended)");
  assert.equal(doc?.version, 2);
  assert.equal(doc?.created_at?.toISOString().slice(0, 10), "2026-07-01", "created_at preserved from the Date bullet");
});

test("sync ADRs: non-numeric legacy ids are never mirrored; ambiguous NNNN prefixes freeze the id", async () => {
  const t = await mkRoot();
  const { stores, adrs } = fakeStores({
    adrs: [
      await mkAdr("0036", "Real decision"),
      await mkAdr("0036-mongoose-data-layer", "Legacy junk doc"),
    ],
  });
  // Two files share the 0036 prefix → the id must be frozen (no pull/push).
  await fs.mkdir(t.adrDir, { recursive: true });
  await fs.writeFile(join(t.adrDir, "0036-real.md"), "# ADR-0036 — Real decision\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\nq\n", "utf-8");
  await fs.writeFile(join(t.adrDir, "0036-real-duplicate.md"), "# ADR-0036 — Duplicate\n\n## Context\nx\n\n## Decision\ny\n\n## Consequences\nz\n", "utf-8");

  const r = await syncProject(P, syncOpts(t, stores));
  assert.equal(r.pulled.length + r.pushed.length + r.conflicts.length, 0);
  assert.ok(r.skipped.some((i) => i.key === "0036-mongoose-data-layer" && /no numérico/.test(i.reason ?? "")));
  assert.ok(r.skipped.some((i) => i.key === "0036" && /ambiguo/.test(i.reason ?? "")));
  assert.equal(adrs.find((a) => a.id === "0036")?.version, 1, "frozen id must not be pushed");
  await assert.rejects(fs.access(join(t.adrDir, "0036-mongoose-data-layer-legacy-junk-doc.md")), "legacy id must not create a file");
});

// ── definitions (skills/agents incl. roles) ──────────────────────────────────

test("sync definitions: skills and agents (roles keep metadata.kind) round-trip through the mirror", async () => {
  const t = await mkRoot();
  const FIXED = new Date("2026-07-06T12:00:00.000Z");
  const { stores, defs } = fakeStores({
    skills: [{ project: P, name: "indexer", description: "Indexes repos", content: "steps...\n", tags: ["skill"], metadata: {}, source: "mcp", created_at: FIXED, updated_at: FIXED } as DefinitionRecord],
    agents: [{ project: P, name: "security-role", description: "Sec role", content: "role brief\n", tags: ["role"], metadata: { kind: "role" }, source: "mcp", created_at: FIXED, updated_at: FIXED } as DefinitionRecord],
  });

  const r1 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r1.pulled.map((i) => `${i.entity}:${i.key}`).sort(), ["agent:security-role", "skill:indexer"]);

  // Edit the role file on disk → pushed back with metadata intact.
  const rolePath = join(t.dir, "agents", "security-role.md");
  await fs.writeFile(rolePath, (await fs.readFile(rolePath, "utf-8")).replace("role brief", "role brief v2"), "utf-8");
  const r2 = await syncProject(P, syncOpts(t, stores));
  assert.deepEqual(r2.pushed.map((i) => i.key), ["security-role"]);
  const saved = defs.agent.find((d) => d.name === "security-role");
  assert.match(saved?.content ?? "", /role brief v2/);
  assert.deepEqual(saved?.metadata, { kind: "role" });
});

// ── manifest ─────────────────────────────────────────────────────────────────

test("sync: manifest is written under <dir>/.sync-state.json, deterministic and pruned when both sides vanish", async () => {
  const t = await mkRoot();
  const { stores, memory } = fakeStores({ memory: [await mkMem("a", "a\n"), await mkMem("b", "b\n")] });
  await syncProject(P, syncOpts(t, stores));
  const s1 = await loadSyncState(t.dir);
  assert.deepEqual(s1.entries.map((e) => `${e.entity}:${e.key}`), ["memory:a", "memory:b"]);
  assert.equal(s1.entries[0].mongoVersion, 1);
  assert.ok(s1.entries[0].diskHash && s1.entries[0].mongoHash);

  // Remove doc+file → the entry is pruned.
  memory.splice(memory.findIndex((d) => d.slug === "b"), 1);
  await fs.rm(join(t.dir, "memory", "b.md"));
  await syncProject(P, syncOpts(t, stores));
  const s2 = await loadSyncState(t.dir);
  assert.deepEqual(s2.entries.map((e) => e.key), ["a"]);
});
