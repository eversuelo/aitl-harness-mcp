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

import { embedOne } from "../ingest/embedder.js";
import type { Provider } from "../providers/base.js";
import { Classifier } from "./classifier.js";
import { type MemoryDoc, makeMemoryDoc } from "./schemas.js";
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
): Promise<Record<string, unknown>[]> {
  // The vector branch loads the embedding model (seconds on first use). A fast caller
  // (e.g. a per-prompt hook) can skip it with useVector=false and go straight to the
  // lexical/recency path, which is what runs anyway until the Atlas vector index exists.
  if (useVector && prompt.trim()) {
    try {
      const hits = await store.vectorSearch(collection, await embedOne(prompt), { project, limit });
      if (hits.length > 0) return hits;
    } catch {
      // fall through to lexical
    }
  }
  try {
    const hits = await store.textSearch(collection, prompt, { project, limit });
    if (hits.length > 0) return hits;
  } catch {
    // fall through to recency
  }
  try {
    return await store.db
      .collection(collection)
      .find({ project }, { projection: { embedding: 0 } })
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
async function renderRepomap(store: MemoryStore, project: string, maxTokens: number): Promise<Section> {
  try {
    const { RepoMap } = await import("../repomap/store.js");
    const map = await new RepoMap(store.db).render(project, { maxTokens });
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

  if (opts.memory !== false) {
    const sec = renderMemory(await relevant(store, "memory", project, prompt, opts.limit ?? 6, useVector), opts.maxChars ?? 4000);
    if (sec.text) parts.push(sec.text);
    sections.memory = sec.count;
  }
  if (opts.decisions !== false) {
    const sec = renderDecisions(await relevant(store, "decisions", project, prompt, 4, useVector), 1800);
    if (sec.text) parts.push(sec.text);
    sections.decisions = sec.count;
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

  return { preamble: parts.join("\n\n"), count: sections.memory, sections };
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

  const doc: MemoryDoc = makeMemoryDoc({
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
