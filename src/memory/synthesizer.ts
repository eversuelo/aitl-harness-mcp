/**
 * Memory synthesizer — compacts a project's memory when it hits a limit.
 *
 * A per-project classifier feeds the memory bank, and when that bank grows past a
 * configured limit (doc count OR token estimate), the synthesizer compacts it. This
 * is the *write/compress* pattern of context engineering; it prevents memory bloat.
 *
 * Algorithm (rolling compression, ADR-0059):
 *   1. Check trigger: LIVE docCount > MEMORY_MAX_DOCS or tokenEstimate > MEMORY_MAX_TOKENS.
 *   2. Group the LIVE memory docs by `category` (docs already absorbed into a synthesis
 *      are excluded by the store).
 *   3. For each group, FOLD the previous synthesis (if any) plus the new docs into a
 *      fresh summary doc (type="synthesis", stable slug, versioned on rewrite) — so a
 *      re-run only processes what accumulated since the last one, not the whole bank.
 *   4. With `compact: true`, stamp the absorbed sources with `compacted_into` so they
 *      leave the live memory (hydrate preamble + trigger) WITHOUT being deleted: they
 *      stay searchable, versioned and mirrored (soft lifecycle, same stance as ADR-0049).
 *   5. Never touch `decisions` (ADRs are durable by design).
 *   6. Log an Event(type="synthesis") with per-category compression stats.
 *
 * The LLM call is delegated to a Provider, map-reduce over bounded chunks (nothing is
 * silently truncated). Without one this falls back to a deterministic extractive
 * summary (first line per source).
 */

import { settings } from "../config.js";
import { embedOne } from "../ingest/embedder.js";
import type { Provider } from "../providers/base.js";
import { makeEvent } from "../models/event.model.js";
import { type MemoryDoc, makeMemoryDoc } from "../models/memory.model.js";
import { RESERVED_MEMORY_TYPES } from "./schemas.js";
import { MemoryStore } from "./store.js";

/** Provenance identity stamped on synthesis docs (same `agent:*` pattern as the MCP actor). */
export const SYNTHESIZER_ACTOR = { id: "agent:synthesizer", role: "agent" } as const;

/** Per-LLM-call input budget (chars, ~4 chars/token). Batches, never truncates. */
export const SYNTH_CHUNK_CHARS = 12_000;

/**
 * Pack texts into ordered batches of at most `maxChars` total. A single text larger
 * than the budget gets its own batch (kept whole — no silent truncation).
 */
export function chunkTexts(texts: string[], maxChars: number = SYNTH_CHUNK_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const t of texts) {
    if (current.length && size + t.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += t.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export interface CategorySynthesis {
  category: string;
  slug: string;
  /** Number of new source docs folded in (excludes the previous synthesis). */
  sources: number;
  /** Whether a previous synthesis existed and was folded into this one. */
  folded: boolean;
  chars_before: number;
  chars_after: number;
}

export interface SynthesisReport {
  /** Slugs of the synthesis docs written. */
  written: string[];
  /** Number of source docs stamped `compacted_into` (0 unless `compact: true`). */
  compacted: number;
  categories: CategorySynthesis[];
}

export interface SynthesizeOpts {
  force?: boolean;
  /**
   * Override the git commit stamped on the synthesis docs ("synthesize the memory as
   * of <ref>", provenance only — no historical reconstruction). When omitted, the
   * store resolves the live HEAD/branch defaults (F2).
   */
  commitSha?: string | null;
  /**
   * Archive the absorbed sources out of the live memory (`compacted_into` ← synthesis
   * slug). Off by default: without it the synthesis is additive, exactly as before.
   */
  compact?: boolean;
}

export class Synthesizer {
  constructor(
    private store: MemoryStore = new MemoryStore(),
    private llm: Provider | null = null,
    /** Injectable embedding fn (tests); defaults to the shared local embedder. */
    private embed: (text: string) => Promise<number[]> = embedOne,
  ) {}

  // ── trigger ─────────────────────────────────────────────────────────
  async shouldSynthesize(project: string): Promise<boolean> {
    const docs = await this.store.memoryDocCount(project);
    const toks = await this.store.memoryTokenEstimate(project);
    return docs > settings.memoryMaxDocs || toks > settings.memoryMaxTokens;
  }

  // ── main entry ──────────────────────────────────────────────────────
  /** Compact `project` memory. Returns the written slugs plus compression stats. */
  async synthesize(project: string, opts: SynthesizeOpts = {}): Promise<SynthesisReport> {
    const report: SynthesisReport = { written: [], compacted: 0, categories: [] };
    if (!opts.force && !(await this.shouldSynthesize(project))) return report;

    const docs = await this.store.iterMemory(project); // LIVE docs only (ADR-0059)
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const d of docs) {
      // Don't re-synthesize syntheses nor SDD artifacts (spec/design/task, ADR-0042):
      // pipeline outputs are first-class records, not raw memory to compact.
      if (RESERVED_MEMORY_TYPES.has(String(d.type))) continue;
      const cat = (d.category as string) ?? "uncategorized";
      (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(d);
    }

    for (const [category, items] of groups) {
      const slug = `synthesis-${project}-${category}`;
      const prior = await this.store.getMemory(project, slug);
      // Fresh categories need ≥2 docs to be worth compacting; with a prior synthesis
      // every new doc gets folded in (rolling compression).
      if (prior === null && items.length < 2) continue;
      if (items.length === 0) continue;

      const priorBody = prior ? String(prior.body ?? "") : "";
      const bodies = items.map((d) => String(d.body ?? ""));
      const sources = priorBody
        ? [`[previous synthesis of '${category}']\n${priorBody}`, ...bodies]
        : bodies;
      const summary = await this.summarize(category, sources);

      const slugs = items.map((d) => d.slug as string).filter(Boolean);
      const priorLinks = prior ? ((prior.links as string[] | undefined) ?? []) : [];
      const doc: MemoryDoc = await makeMemoryDoc({
        project,
        slug,
        type: "synthesis",
        description: `Synthesized memory for category '${category}' (${slugs.length} new sources${prior ? ", folded into previous synthesis" : ""}).`,
        body: summary,
        category,
        tags: ["synthesis"],
        links: [...new Set([...priorLinks, ...slugs])],
      });
      doc.embedding = await this.embed(`${doc.description}\n${doc.body}`);
      // Provenance: attribute the synthesis to the synthesizer agent at the requested
      // commit (branch/commit default to the live git context inside the store).
      await this.store.upsertMemory(doc, {
        actor: SYNTHESIZER_ACTOR,
        ...(opts.commitSha !== undefined ? { commit_sha: opts.commitSha } : {}),
      });
      if (opts.compact) {
        report.compacted += await this.store.markCompacted(project, slugs, slug);
      }
      report.written.push(slug);
      report.categories.push({
        category,
        slug,
        sources: slugs.length,
        folded: prior !== null,
        chars_before: sources.reduce((n, s) => n + s.length, 0),
        chars_after: summary.length,
      });
    }

    await this.store.logEvent(
      await makeEvent({
        project,
        type: "synthesis",
        payload: {
          groups: [...groups.keys()],
          written: report.written,
          compacted: report.compacted,
          categories: report.categories,
        },
      }),
    );
    return report;
  }

  // ── summary strategies ──────────────────────────────────────────────
  /**
   * Summarize `sources` for a category. With an LLM: map-reduce over bounded chunks —
   * each batch is summarized whole, and multiple batch summaries are folded by one
   * final call — so no source is ever silently dropped. Without one: deterministic
   * extractive summary (first line per source).
   */
  private async summarize(category: string, sources: string[]): Promise<string> {
    if (this.llm !== null) {
      const instruction = (notes: string) =>
        `Synthesize these '${category}' notes into a concise, de-duplicated summary. ` +
        `Preserve concrete facts, decisions and [[links]]. Notes:\n\n${notes}`;
      const batches = chunkTexts(sources);
      const partials: string[] = [];
      for (const batch of batches) {
        partials.push((await this.llm.complete(instruction(batch.join("\n\n---\n\n")))).trim());
      }
      const out =
        partials.length === 1
          ? partials[0]
          : (await this.llm.complete(instruction(partials.join("\n\n---\n\n")))).trim();
      // A blank model reply must never become the synthesis: with `compact` the sources
      // are archived against it, so an empty body would silently destroy knowledge.
      if (out) return out;
    }
    return this.extractive(category, sources);
  }

  /** Deterministic fallback: extractive (headline line per source). Never blank. */
  private extractive(category: string, sources: string[]): string {
    const lines = [`# Synthesis: ${category}`, ""];
    for (const b of sources) {
      const first = b.split(/\r?\n/).find((ln) => ln.trim()) ?? "";
      if (first) lines.push(`- ${first.trim().slice(0, 200)}`);
    }
    return lines.join("\n");
  }
}
