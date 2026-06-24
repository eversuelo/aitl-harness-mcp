/**
 * Skill router — Pillar 3, native to this harness.
 *
 * At session start (alongside memory `hydrate`), pick the project skills most relevant
 * to the task prompt and inject their instructions into the system preamble (the
 * `skills_route` step). A skill is a reusable, project-scoped capability stored in the
 * `skills` collection (see `src/projectctx/store.ts`).
 *
 * Selection is a robust cascade so it works on any deployment:
 *   1. lexical search (Mongo `$text` / regex fallback) of the `skills` collection,
 *   2. recency fallback when search finds nothing,
 *   3. optional semantic re-rank of the candidate set by embedding cosine — best-effort,
 *      since skill records carry no stored embedding, vectors are computed in-process.
 *
 * Like the memory lifecycle, every step is best-effort: a failure skips the hook, never
 * breaks the run.
 */

import { getEmbedder } from "../ingest/embedder.js";
import { DefinitionStore } from "./store.js";

type Skill = Record<string, unknown>;

/** Cosine similarity; tolerant of un-normalized vectors (Voyage) and zero vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Short text used to rank a skill against the prompt. */
function rankText(s: Skill): string {
  return [String(s.name ?? ""), String(s.description ?? ""), String(s.content ?? "").slice(0, 1000)]
    .filter(Boolean)
    .join(" ");
}

/** Semantically re-rank candidates by embedding cosine vs the prompt; identity on failure. */
async function rerank(prompt: string, candidates: Skill[]): Promise<Skill[]> {
  if (candidates.length < 2) return candidates;
  try {
    const [promptVec, ...skillVecs] = await getEmbedder().embed([
      prompt,
      ...candidates.map(rankText),
    ]);
    return candidates
      .map((s, i) => ({ s, score: cosine(promptVec, skillVecs[i]) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  } catch {
    return candidates; // keep lexical order
  }
}

/** Candidate set: lexical search first, recency as the fallback. */
async function candidateSkills(
  store: DefinitionStore,
  project: string,
  prompt: string,
  poolSize: number,
): Promise<Skill[]> {
  try {
    const hits = await store.search(project, prompt, poolSize);
    if (hits.length > 0) return hits;
  } catch {
    // fall through to recency
  }
  try {
    return await store.list(project, { limit: poolSize });
  } catch {
    return [];
  }
}

export interface RouteSkillsResult {
  /** System-prompt section injecting the selected skills, or "" when none apply. */
  preamble: string;
  /** Names of the skills injected, best-first. */
  selected: string[];
}

/**
 * Select the project skills most relevant to `prompt` and render them as a system
 * preamble. Returns an empty preamble (no names) when the project has no usable skills.
 */
export async function routeSkills(
  project: string,
  prompt: string,
  opts: { store?: DefinitionStore; limit?: number; poolSize?: number; maxChars?: number; rerank?: boolean } = {},
): Promise<RouteSkillsResult> {
  const store = opts.store ?? new DefinitionStore("skill");
  const limit = opts.limit ?? 3;
  const poolSize = opts.poolSize ?? Math.max(limit * 3, 10);
  const maxChars = opts.maxChars ?? 6000;

  const pool = await candidateSkills(store, project, prompt, poolSize);
  if (pool.length === 0) return { preamble: "", selected: [] };

  const ranked = opts.rerank === false ? pool : await rerank(prompt, pool);

  const lines = [
    "## Project skills (relevant capabilities for this task)",
    "Apply these project skills when they fit the work; follow their instructions.",
    "",
  ];
  const selected: string[] = [];
  let budget = maxChars;
  for (const s of ranked) {
    if (selected.length >= limit) break;
    const name = String(s.name ?? "").trim();
    if (!name) continue;
    const desc = String(s.description ?? "").trim();
    const content = String(s.content ?? "").trim();
    if (!content) continue;
    const header = `### ${name}${desc ? ` — ${desc}` : ""}`;
    const body = content.slice(0, budget - header.length - 2);
    if (body.length < 1) break; // out of budget
    const block = `${header}\n${body}`;
    lines.push(block, "");
    budget -= block.length + 1;
    selected.push(name);
  }

  if (selected.length === 0) return { preamble: "", selected: [] };
  return { preamble: lines.join("\n").trimEnd(), selected };
}
