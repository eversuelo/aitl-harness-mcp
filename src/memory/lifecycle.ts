/**
 * Session memory lifecycle — the "Engram-style" protocol, native to this harness.
 *
 * Three hooks around an agent run (see `runAgent` in src/orchestration/graph.ts):
 *   1. hydrate()  — at session START, pull the project's most relevant durable memory
 *      and render it as a system preamble (the `mem_context` step).
 *   2. summarizeSession() — at session END, compress the transcript into ONE durable,
 *      classified, embedded memory doc (the `mem_session_summary` step). Because it is
 *      auto-classified, a run that made a decision/bugfix/discovery is saved under that
 *      category with no explicit `mem_save` call (the auto-save trigger).
 *
 * Everything is best-effort: a failure here never breaks the run, only skips the hook.
 */

import { INACTIVE_ADR_STATUSES, isReviewOverdue } from "../decisions/lifecycle.js";
import { embedOne } from "../ingest/embedder.js";
import type { Provider } from "../providers/base.js";
import { Classifier } from "./classifier.js";
import { type MemoryDoc, makeMemoryDoc } from "../models/memory.model.js";
import { MemoryStore } from "./store.js";

/** Categories that mark a run as worth remembering beyond a plain summary. */
export const TRIGGER_CATEGORIES = new Set(["decision", "bug", "convention", "reference"]);

type Msg = Record<string, unknown>;

/**
 * Fetch a project's most relevant docs in `collection` for `prompt`.
 *
 * Tries semantic search first, then lexical search when vector search is unavailable
 * (throws) OR returns nothing (no vector index, missing embeddings), then recency. So
 * hydration works on a fresh/un-indexed deployment and across any collection.
 */
async function relevant(
  store: MemoryStore,
  collection: string,
  project: string,
  prompt: string,
  limit: number,
  useVector = true,
  repo?: string,
): Promise<Record<string, unknown>[]> {
  // Optional repo sub-scope (ADR-0028): applied as a post-filter on the vector/text
  // paths (whose backends only filter by project) and natively in the recency query.
  // Memory docs absorbed into a synthesis (`compacted_into`, ADR-0059) are excluded from
  // the hydrate preamble — their synthesis represents them; explicit search tools still
  // reach them for deep recall.
  const byRepo = (rows: Record<string, unknown>[]) =>
    (repo === undefined ? rows : rows.filter((r) => (r.repo ?? null) === repo)).filter(
      (r) => !r.compacted_into,
    );

  // The vector branch loads the embedding model (seconds on first use). A fast caller
  // (e.g. a per-prompt hook) can skip it with useVector=false and go straight to the
  // lexical/recency path, which is what runs anyway until the Atlas vector index exists.
  if (useVector && prompt.trim()) {
    try {
      const hits = byRepo(await store.vectorSearch(collection, await embedOne(prompt), { project, limit }));
      if (hits.length > 0) return hits;
    } catch {
      // fall through to lexical
    }
  }
  try {
    const hits = byRepo(await store.textSearch(collection, prompt, { project, limit }));
    if (hits.length > 0) return hits;
  } catch {
    // fall through to recency
  }
  try {
    // `compacted_into: null` also matches docs without the field, so the filter is a
    // no-op on collections that don't carry the lifecycle flag (decisions, etc.).
    const query: Record<string, unknown> = { project, compacted_into: null };
    if (repo !== undefined) query.repo = repo;
    return await store.db
      .collection(collection)
      .find(query, { projection: { embedding: 0 } })
      .sort({ updated_at: -1 })
      .limit(limit)
      .toArray();
  } catch {
    return [];
  }
}

const clip = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

interface Section {
  text: string;
  count: number;
}

/** Render durable memory docs as a budgeted bullet list. */
function renderMemory(hits: Record<string, unknown>[], cap: number): Section {
  const lines: string[] = [];
  let budget = cap;
  for (const h of hits) {
    const slug = String(h.slug ?? "");
    const desc = String(h.description ?? "");
    const cat = h.category ? ` (${String(h.category)})` : "";
    const body = clip(String(h.body ?? ""), 400);
    const entry = `- [[${slug}]]${cat}: ${desc || body}${desc && body ? ` — ${body}` : ""}`;
    if (entry.length > budget) break;
    lines.push(entry);
    budget -= entry.length;
  }
  if (!lines.length) return { text: "", count: 0 };
  return {
    text: [
      "## Project memory (durable context recovered for this session)",
      "Use these prior decisions, conventions and notes; do not contradict them silently.",
      "",
      ...lines,
    ].join("\n"),
    count: lines.length,
  };
}

/** An ADR whose soft TTL (`review_after`) lapsed: flagged for review, never injected. */
export interface NeedsReviewEntry {
  id: string;
  title: string;
  review_after: Date | string | null;
}

/**
 * Lifecycle filter for hydration (F4): split retrieved ADRs into the ones still safe
 * to inject (active, not past their soft TTL) and the lapsed ones (`needs_review`).
 * Deprecated/superseded ADRs are dropped from the preamble entirely.
 */
export function partitionDecisions(
  hits: Record<string, unknown>[],
  now: Date = new Date(),
): { active: Record<string, unknown>[]; needsReview: NeedsReviewEntry[] } {
  const active: Record<string, unknown>[] = [];
  const needsReview: NeedsReviewEntry[] = [];
  for (const d of hits) {
    if (INACTIVE_ADR_STATUSES.has(String(d.status ?? ""))) continue;
    if (isReviewOverdue(d.review_after, now)) {
      needsReview.push({
        id: String(d.id ?? ""),
        title: String(d.title ?? ""),
        review_after: (d.review_after as Date | string | null) ?? null,
      });
      continue;
    }
    active.push(d);
  }
  return { active, needsReview };
}

/** Render Architecture Decision Records as a budgeted bullet list. */
function renderDecisions(hits: Record<string, unknown>[], cap: number): Section {
  const lines: string[] = [];
  let budget = cap;
  for (const d of hits) {
    const id = String(d.id ?? "");
    const title = String(d.title ?? "");
    const decision = clip(String(d.decision ?? ""), 240);
    const entry = `- ADR ${id} — ${title}: ${decision}`;
    if (entry.length > budget) break;
    lines.push(entry);
    budget -= entry.length;
  }
  if (!lines.length) return { text: "", count: 0 };
  return {
    text: ["## Architecture decisions (durable; do not contradict)", "", ...lines].join("\n"),
    count: lines.length,
  };
}

/** Render project conventions (rules) as a budgeted bullet list. */
function renderConventions(rows: Record<string, unknown>[], cap: number): Section {
  const lines: string[] = [];
  let budget = cap;
  for (const c of rows) {
    const rule = clip(String(c.rule ?? ""), 200);
    if (!rule) continue;
    const entry = `- [${String(c.severity ?? "warn")}] ${rule}`;
    if (entry.length > budget) break;
    lines.push(entry);
    budget -= entry.length;
  }
  if (!lines.length) return { text: "", count: 0 };
  return {
    text: ["## Project conventions (follow and enforce these)", "", ...lines].join("\n"),
    count: lines.length,
  };
}

/** Render the repo map (top symbols by PageRank). Lazily imports RepoMap to avoid the parser. */
async function renderRepomap(store: MemoryStore, project: string, maxTokens: number, repo?: string): Promise<Section> {
  try {
    const { RepoMap } = await import("../repomap/store.js");
    const map = await new RepoMap(store.db).render(project, repo !== undefined ? { maxTokens, repo } : { maxTokens });
    if (!map || map.startsWith("(repo map empty")) return { text: "", count: 0 };
    return { text: ["## Repo map (top symbols by importance)", "```", map, "```"].join("\n"), count: 1 };
  } catch {
    return { text: "", count: 0 };
  }
}

export interface HydrateResult {
  preamble: string;
  /** Memory docs injected (kept for back-compat). */
  count: number;
  /** Per-source breakdown of what was injected. */
  sections: { memory: number; decisions: number; conventions: number; repomap: number };
  /**
   * ADRs whose `review_after` soft TTL lapsed (F4): excluded from the preamble but NOT
   * silent — the preamble carries a one-line pointer and the host gets the list here.
   */
  needs_review: NeedsReviewEntry[];
}

export interface HydrateOpts {
  store?: MemoryStore;
  limit?: number;
  maxChars?: number;
  memory?: boolean;
  decisions?: boolean;
  conventions?: boolean;
  repomap?: boolean;
  repomapTokens?: number;
  /** Use embeddings for relevance (vector→text→recency). Set false for a fast hook path. */
  vector?: boolean;
  /** Narrow memory + repo map to a single repo sub-scope within the project (ADR-0028). */
  repo?: string;
}

/**
 * Build a system preamble from ALL of a project's relevant durable context:
 * memory + architecture decisions + conventions + repo map. Each source is best-effort
 * and individually budgeted; an empty preamble means there was nothing to inject.
 */
export async function hydrate(
  project: string,
  prompt: string,
  opts: HydrateOpts = {},
): Promise<HydrateResult> {
  const store = opts.store ?? new MemoryStore();
  const useVector = opts.vector !== false;
  const parts: string[] = [];
  const sections = { memory: 0, decisions: 0, conventions: 0, repomap: 0 };
  let needsReview: NeedsReviewEntry[] = [];

  if (opts.memory !== false) {
    const sec = renderMemory(await relevant(store, "memory", project, prompt, opts.limit ?? 6, useVector, opts.repo), opts.maxChars ?? 4000);
    if (sec.text) parts.push(sec.text);
    sections.memory = sec.count;
  }
  if (opts.decisions !== false) {
    // Rank by relevance (over-fetch), then ALWAYS union the most-recent ADRs so a
    // freshly recorded decision is considered even when lexical/vector search ranked
    // older ones first — relevant() stops at the first non-empty tier and may never
    // reach its recency fallback. Recent-first + dedupe by id keeps new ADRs visible.
    // Then drop deprecated/superseded and soft-TTL-lapsed ADRs (F4).
    const decLimit = opts.limit ?? 6;
    const ranked = await relevant(store, "decisions", project, prompt, Math.max(decLimit * 2, 8), useVector);
    let recent: Record<string, unknown>[] = [];
    try {
      recent = await store.db
        .collection("decisions")
        .find({ project }, { projection: { embedding: 0 } })
        .sort({ updated_at: -1 })
        .limit(decLimit)
        .toArray();
    } catch {
      // recency is best-effort; the ranked hits already cover the common case
    }
    const seen = new Set<string>();
    const merged: Record<string, unknown>[] = [];
    for (const d of [...recent, ...ranked]) {
      const id = String(d.id ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(d);
    }
    const split = partitionDecisions(merged);
    needsReview = split.needsReview;
    // Best-effort: lapsed ADRs are surfaced even when retrieval didn't rank them.
    try {
      const lapsed = await store.db
        .collection("decisions")
        .find(
          { project, review_after: { $ne: null, $lt: new Date() }, status: { $nin: [...INACTIVE_ADR_STATUSES] } },
          { projection: { id: 1, title: 1, review_after: 1 } },
        )
        .limit(20)
        .toArray();
      const seen = new Set(needsReview.map((e) => e.id));
      for (const d of lapsed) {
        const id = String(d.id ?? "");
        if (!id || seen.has(id)) continue;
        needsReview.push({ id, title: String(d.title ?? ""), review_after: (d.review_after as Date | null) ?? null });
      }
    } catch {
      // The retrieved-hits partition already covers the common case.
    }
    const sec = renderDecisions(split.active.slice(0, decLimit), 1800);
    if (sec.text) parts.push(sec.text);
    sections.decisions = sec.count;
    if (needsReview.length) {
      // One short pointer line — the host sees it without injecting full (stale) content.
      parts.push(`ADRs pendientes de revisión (review_after vencido): ${needsReview.map((e) => e.id).join(", ")}`);
    }
  }
  if (opts.conventions !== false) {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await store.db.collection("conventions").find({ project }).limit(20).toArray();
    } catch {
      // conventions are optional
    }
    const sec = renderConventions(rows, 1200);
    if (sec.text) parts.push(sec.text);
    sections.conventions = sec.count;
  }
  if (opts.repomap !== false) {
    const sec = await renderRepomap(store, project, opts.repomapTokens ?? 400);
    if (sec.text) parts.push(sec.text);
    sections.repomap = sec.count;
  }

  return { preamble: parts.join("\n\n"), count: sections.memory, sections, needs_review: needsReview };
}

export interface SessionSummary {
  slug: string;
  category: string;
  type: MemoryDoc["type"];
}

/** Best-effort LLM summary of the transcript; deterministic fallback without a provider. */
async function summarizeTranscript(convo: Msg[], llm: Provider | null): Promise<string> {
  const joined = convo
    .map((m) => `${String(m.role)}: ${String(m.content ?? "")}`)
    .join("\n")
    .slice(0, 12_000);
  if (llm !== null) {
    const out = await llm.complete(
      "Summarize this agent session into durable project memory. Preserve decisions, " +
        "conventions, bugfixes, file paths and any [[links]]. Be concise:\n\n" +
        joined,
    );
    return out.trim();
  }
  // Deterministic fallback: keep the assistant's conclusions.
  const conclusions = convo
    .filter((m) => m.role === "assistant" && String(m.content ?? "").trim())
    .map((m) => String(m.content).trim());
  return conclusions.join("\n\n").slice(0, 2000) || joined.slice(0, 2000);
}

/**
 * Compress a finished run into ONE durable, classified, embedded memory doc.
 * Returns null when there is nothing meaningful to store.
 */
export async function summarizeSession(
  project: string,
  runId: string,
  convo: Msg[],
  opts: { store?: MemoryStore; provider?: Provider; extraTags?: string[] } = {},
): Promise<SessionSummary | null> {
  const store = opts.store ?? new MemoryStore();
  const llm = opts.provider ?? null;

  const summary = await summarizeTranscript(convo, llm);
  if (!summary.trim()) return null;

  // Auto-classify (rules-first; LLM only if a provider was supplied) → the auto-save trigger.
  const category = await new Classifier(undefined, llm).classifyText(summary);
  const type: MemoryDoc["type"] = "project";
  // De-dup tags: base session tag + the trigger category + caller extras (e.g. component:src/foo).
  const tags = [
    ...new Set([
      "session",
      ...(TRIGGER_CATEGORIES.has(category) ? [category] : []),
      ...(opts.extraTags ?? []),
    ]),
  ];
  const slug = `session-${runId.slice(0, 8)}`;

  const doc: MemoryDoc = await makeMemoryDoc({
    project,
    slug,
    type,
    category,
    description: `Session summary (${category}) — run ${runId.slice(0, 8)}`,
    body: summary,
    tags,
  });
  try {
    doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
  } catch {
    // Embedding is optional; the doc is still text-searchable.
  }
  await store.upsertMemory(doc);
  return { slug, category, type };
}
