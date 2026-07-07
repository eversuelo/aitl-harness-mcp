import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "../providers/base.js";
import type { MemoryDoc } from "../models/memory.model.js";
import type { MemoryStore } from "./store.js";
import { SYNTH_CHUNK_CHARS, Synthesizer, chunkTexts } from "./synthesizer.js";

// Rolling compression (ADR-0059): fold the previous synthesis + only the new docs,
// map-reduce instead of silent truncation, and --compact archives sources without
// deleting them. All seams are duck-typed fakes — no Mongo, no embedder download.

/** Minimal in-memory stand-in for the MemoryStore surface the synthesizer touches. */
class FakeStore {
  docs = new Map<string, Record<string, unknown>>();
  compactedCalls: { slugs: string[]; into: string }[] = [];
  events: Record<string, unknown>[] = [];

  seed(doc: Record<string, unknown>): void {
    this.docs.set(String(doc.slug), doc);
  }
  async iterMemory(_project: string): Promise<Record<string, unknown>[]> {
    return [...this.docs.values()].filter((d) => !d.compacted_into);
  }
  async getMemory(_project: string, slug: string): Promise<Record<string, unknown> | null> {
    return this.docs.get(slug) ?? null;
  }
  async upsertMemory(doc: MemoryDoc): Promise<string> {
    this.docs.set(doc.slug, doc as unknown as Record<string, unknown>);
    return doc.slug;
  }
  async markCompacted(_project: string, slugs: string[], into: string): Promise<number> {
    this.compactedCalls.push({ slugs, into });
    for (const s of slugs) {
      const d = this.docs.get(s);
      if (d) d.compacted_into = into;
    }
    return slugs.length;
  }
  async logEvent(event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
  }
}

/** Provider fake: records every prompt, answers with a fixed summary. */
const fakeLlm = (answers: string[] = []): Provider & { prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    name: "fake",
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      return answers.shift() ?? "RESUMEN";
    },
    async chat() {
      throw new Error("unused");
    },
  } as unknown as Provider & { prompts: string[] };
};

const fakeEmbed = async (_: string): Promise<number[]> => [0.1, 0.2];

const mem = (slug: string, category: string, body: string, extra: Record<string, unknown> = {}) => ({
  project: "p",
  slug,
  type: "project",
  category,
  body,
  links: [],
  ...extra,
});

const synth = (store: FakeStore, llm: Provider | null) =>
  new Synthesizer(store as unknown as MemoryStore, llm, fakeEmbed);

// ── chunkTexts ─────────────────────────────────────────────────────────

test("chunkTexts packs in order without losing or splitting any text", () => {
  const chunks = chunkTexts(["aa", "bb", "cc", "dd"], 5);
  assert.deepEqual(chunks, [["aa", "bb"], ["cc", "dd"]]);
});

test("chunkTexts keeps an oversized text whole in its own batch", () => {
  const big = "x".repeat(50);
  const chunks = chunkTexts(["aa", big, "bb"], 10);
  assert.deepEqual(chunks, [["aa"], [big], ["bb"]]);
});

// ── grouping / thresholds ──────────────────────────────────────────────

test("a fresh category needs at least 2 docs; reserved types are never compacted", async () => {
  const store = new FakeStore();
  store.seed(mem("solo", "bug", "one bug note"));
  store.seed(mem("spec-1", "task", "a spec", { type: "spec" }));
  store.seed(mem("spec-2", "task", "another spec", { type: "spec" }));
  const report = await synth(store, null).synthesize("p", { force: true });
  assert.deepEqual(report.written, []);
  assert.equal(report.compacted, 0);
});

test("extractive fallback lists every source (no truncation by count)", async () => {
  const store = new FakeStore();
  for (let i = 0; i < 5; i++) store.seed(mem(`n${i}`, "bug", `headline ${i}\ndetail`));
  const report = await synth(store, null).synthesize("p", { force: true });
  assert.deepEqual(report.written, ["synthesis-p-bug"]);
  const body = String(store.docs.get("synthesis-p-bug")!.body);
  for (let i = 0; i < 5; i++) assert.ok(body.includes(`headline ${i}`), `missing headline ${i}`);
  const [cat] = report.categories;
  assert.equal(cat.sources, 5);
  assert.equal(cat.folded, false);
  assert.ok(cat.chars_before > 0 && cat.chars_after > 0);
});

// ── rolling fold ───────────────────────────────────────────────────────

test("a prior synthesis folds in even a single new doc, unioning links", async () => {
  const store = new FakeStore();
  store.seed({
    ...mem("synthesis-p-bug", "bug", "old compressed knowledge", { type: "synthesis" }),
    links: ["n0", "n1"],
  });
  store.seed(mem("n2", "bug", "fresh bug note"));
  const llm = fakeLlm();
  const report = await synth(store, llm).synthesize("p", { force: true });
  assert.deepEqual(report.written, ["synthesis-p-bug"]);
  assert.equal(report.categories[0].folded, true);
  assert.equal(report.categories[0].sources, 1);
  // The previous synthesis body is part of the LLM input (nothing forgotten)…
  assert.ok(llm.prompts[0].includes("old compressed knowledge"));
  assert.ok(llm.prompts[0].includes("fresh bug note"));
  // …and the new doc's slug joins the accumulated provenance links.
  assert.deepEqual([...(store.docs.get("synthesis-p-bug")!.links as string[])].sort(), ["n0", "n1", "n2"]);
});

// ── map-reduce ─────────────────────────────────────────────────────────

test("sources beyond the chunk budget are map-reduced, never sliced away", async () => {
  const store = new FakeStore();
  const half = "y".repeat(Math.ceil(SYNTH_CHUNK_CHARS * 0.6));
  store.seed(mem("a", "notes", half));
  store.seed(mem("b", "notes", half));
  const llm = fakeLlm(["partial-1", "partial-2", "final"]);
  const report = await synth(store, llm).synthesize("p", { force: true });
  assert.equal(llm.prompts.length, 3); // 2 batches + 1 reduce
  assert.ok(llm.prompts[2].includes("partial-1") && llm.prompts[2].includes("partial-2"));
  assert.equal(String(store.docs.get("synthesis-p-notes")!.body), "final");
  assert.equal(report.categories[0].chars_after, "final".length);
});

// ── compaction ─────────────────────────────────────────────────────────

test("compact:true archives the absorbed sources; the next run only sees new docs", async () => {
  const store = new FakeStore();
  store.seed(mem("n0", "bug", "first"));
  store.seed(mem("n1", "bug", "second"));
  const first = await synth(store, fakeLlm(["v1"])).synthesize("p", { force: true, compact: true });
  assert.equal(first.compacted, 2);
  assert.deepEqual(store.compactedCalls, [{ slugs: ["n0", "n1"], into: "synthesis-p-bug" }]);
  assert.equal(store.docs.get("n0")!.compacted_into, "synthesis-p-bug");

  // Second run: only the fresh doc is live; the synthesis folds v1 + the new doc.
  store.seed(mem("n2", "bug", "third"));
  const llm = fakeLlm(["v2"]);
  const second = await synth(store, llm).synthesize("p", { force: true, compact: true });
  assert.equal(second.categories[0].sources, 1);
  assert.equal(second.categories[0].folded, true);
  assert.ok(llm.prompts[0].includes("v1") && llm.prompts[0].includes("third"));
  assert.ok(!llm.prompts[0].includes("first"), "compacted source must not be re-read");
  assert.equal(second.compacted, 1);
});

test("without compact, sources stay live (additive behavior preserved)", async () => {
  const store = new FakeStore();
  store.seed(mem("n0", "bug", "first"));
  store.seed(mem("n1", "bug", "second"));
  await synth(store, null).synthesize("p", { force: true });
  assert.equal(store.compactedCalls.length, 0);
  assert.equal(store.docs.get("n0")!.compacted_into, undefined);
});

test("a blank LLM reply falls back to extractive — a synthesis is never empty", async () => {
  const store = new FakeStore();
  store.seed(mem("n0", "bug", "primer hallazgo\ndetalle"));
  store.seed(mem("n1", "bug", "segundo hallazgo\ndetalle"));
  await synth(store, fakeLlm(["  "])).synthesize("p", { force: true, compact: true });
  const body = String(store.docs.get("synthesis-p-bug")!.body);
  assert.ok(body.includes("primer hallazgo") && body.includes("segundo hallazgo"));
});

// ── telemetry ──────────────────────────────────────────────────────────

test("the synthesis event carries the compression stats", async () => {
  const store = new FakeStore();
  store.seed(mem("n0", "bug", "first"));
  store.seed(mem("n1", "bug", "second"));
  await synth(store, null).synthesize("p", { force: true, compact: true });
  assert.equal(store.events.length, 1);
  const payload = store.events[0].payload as Record<string, unknown>;
  assert.deepEqual(payload.written, ["synthesis-p-bug"]);
  assert.equal(payload.compacted, 2);
  assert.equal((payload.categories as unknown[]).length, 1);
});
