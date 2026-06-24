/**
 * Memory synthesizer — compacts a project's memory when it hits a limit.
 *
 * A per-project classifier feeds the memory bank, and when that bank grows past a
 * configured limit (doc count OR token estimate), the synthesizer compacts it. This
 * is the *write/compress* pattern of context engineering; it prevents memory bloat.
 *
 * Algorithm:
 *   1. Check trigger: docCount > MEMORY_MAX_DOCS or tokenEstimate > MEMORY_MAX_TOKENS.
 *   2. Group memory docs by `category`.
 *   3. For each large group, synthesize a higher-level summary doc (type="synthesis").
 *   4. Write the synthesis doc; never touch `decisions` (ADRs are durable by design).
 *   5. Log an Event(type="synthesis") for thesis analysis.
 *
 * The LLM call is delegated to a Provider. Without one this falls back to a
 * deterministic extractive summary (first line per source).
 */

import { settings } from "../config.js";
import { embedOne } from "../ingest/embedder.js";
import type { Provider } from "../providers/base.js";
import { type MemoryDoc, makeEvent, makeMemoryDoc } from "./schemas.js";
import { MemoryStore } from "./store.js";

export class Synthesizer {
  constructor(
    private store: MemoryStore = new MemoryStore(),
    private llm: Provider | null = null,
  ) {}

  // ── trigger ─────────────────────────────────────────────────────────
  async shouldSynthesize(project: string): Promise<boolean> {
    const docs = await this.store.memoryDocCount(project);
    const toks = await this.store.memoryTokenEstimate(project);
    return docs > settings.memoryMaxDocs || toks > settings.memoryMaxTokens;
  }

  // ── main entry ──────────────────────────────────────────────────────
  /** Compact `project` memory. Returns the slugs of synthesis docs written. */
  async synthesize(project: string, opts: { force?: boolean } = {}): Promise<string[]> {
    if (!opts.force && !(await this.shouldSynthesize(project))) return [];

    const docs = await this.store.iterMemory(project);
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const d of docs) {
      if (d.type === "synthesis") continue; // don't re-synthesize syntheses
      const cat = (d.category as string) ?? "uncategorized";
      (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(d);
    }

    const written: string[] = [];
    for (const [category, items] of groups) {
      if (items.length < 2) continue; // nothing to compact
      const summary = await this.summarize(category, items);
      const slug = `synthesis-${project}-${category}`;
      const doc: MemoryDoc = makeMemoryDoc({
        project,
        slug,
        type: "synthesis",
        description: `Synthesized memory for category '${category}' (${items.length} sources).`,
        body: summary,
        category,
        tags: ["synthesis"],
        links: items.map((d) => d.slug as string).filter(Boolean),
      });
      doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
      await this.store.upsertMemory(doc);
      written.push(slug);
    }

    await this.store.logEvent(
      makeEvent({ project, type: "synthesis", payload: { groups: [...groups.keys()], written } }),
    );
    return written;
  }

  // ── summary strategies ──────────────────────────────────────────────
  private async summarize(category: string, items: Record<string, unknown>[]): Promise<string> {
    const bodies = items.map((i) => String(i.body ?? ""));
    if (this.llm !== null) {
      const joined = bodies.join("\n\n---\n\n").slice(0, 12_000);
      const prompt =
        `Synthesize these '${category}' notes into a concise, de-duplicated summary. ` +
        `Preserve concrete facts, decisions and [[links]]. Notes:\n\n${joined}`;
      return (await this.llm.complete(prompt)).trim();
    }
    // Deterministic fallback: extractive (headline lines).
    const lines = [`# Synthesis: ${category}`, ""];
    for (const b of bodies) {
      const first = b.split(/\r?\n/).find((ln) => ln.trim()) ?? "";
      if (first) lines.push(`- ${first.trim().slice(0, 200)}`);
    }
    return lines.join("\n");
  }
}
