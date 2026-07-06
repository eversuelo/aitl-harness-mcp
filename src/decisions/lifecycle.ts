/**
 * ADR lifecycle (F4) — deprecation with a reason + soft TTL + curation proposals.
 *
 * Deprecating an ADR NEVER deletes it: the doc stays in `decisions` (append-only
 * traceability) with `status:"deprecated"` + `deprecation_reason`, and the prior
 * version is archived in `decisions_history` by the normal versioning path.
 * `review_after` is a SOFT TTL: past that date the ADR is flagged "needs review"
 * and excluded from hydrate's preamble — it is never removed.
 *
 * `proposeDeprecations` is the curation half: it only PROPOSES candidates (with a
 * motive); a human (or explicit tool call) must deprecate. Never automatic.
 */

import { ensureMongoose } from "../db/mongoose.js";
import type { VersioningActor } from "../memory/versioning.js";
import { type ADR, DecisionModel, makeADR } from "../models/decision.model.js";
import { ADRStore } from "./adr.js";

/** Statuses already out of the active set (excluded from hydrate; not re-proposed). */
export const INACTIVE_ADR_STATUSES = new Set(["deprecated", "superseded"]);

/** True when the ADR's soft TTL has lapsed (`review_after < now`). */
export function isReviewOverdue(reviewAfter: unknown, now: Date = new Date()): boolean {
  if (reviewAfter == null) return false;
  const d = reviewAfter instanceof Date ? reviewAfter : new Date(String(reviewAfter));
  return !Number.isNaN(d.getTime()) && d.getTime() < now.getTime();
}

// ── deprecate ─────────────────────────────────────────────────────────────────

export interface DeprecateOpts {
  project: string;
  id: string;
  reason: string;
  /** Id of the ADR that replaces this one (optional). */
  supersededBy?: string | null;
  /** New soft-TTL review date (optional). */
  reviewAfter?: Date | null;
  actor?: VersioningActor;
  /** Explicit git provenance; when omitted the store resolves live defaults (F2). */
  branch?: string | null;
  commit_sha?: string | null;
}

export interface DeprecateResult {
  id: string;
  status: string;
  version: number;
}

/** Injectable persistence seam (tests stub these; production uses the real models/store). */
export interface DeprecateDeps {
  load: (project: string, id: string) => Promise<Record<string, unknown> | null>;
  upsert: (
    adr: ADR,
    opts: { embed?: boolean; actor?: VersioningActor; branch?: string | null; commit_sha?: string | null },
  ) => Promise<string>;
}

const defaultDeps: DeprecateDeps = {
  load: async (project, id) => {
    await ensureMongoose();
    return DecisionModel.findOne({ project, id }, { embedding: 0 }).lean() as unknown as Promise<Record<
      string,
      unknown
    > | null>;
  },
  // embed:false → the content (title/context/decision) is unchanged, keep the stored embedding.
  upsert: (adr, opts) => new ADRStore().upsert(adr, { ...opts, embed: false }),
};

/**
 * Mark an ADR as deprecated (status + reason + optional superseded_by/review_after)
 * and re-upsert it through the normal versioning path (version bump + history snapshot).
 */
export async function deprecateDecision(
  opts: DeprecateOpts,
  deps: Partial<DeprecateDeps> = {},
): Promise<DeprecateResult> {
  const { load, upsert } = { ...defaultDeps, ...deps };
  const existing = await load(opts.project, opts.id);
  if (!existing) throw new Error(`No ADR '${opts.id}' in project '${opts.project}'.`);

  const { _id, embedding, ...rest } = existing;
  const next = await makeADR({
    ...(rest as Partial<ADR> & {
      project: string;
      id: string;
      title: string;
      context: string;
      decision: string;
      consequences: string;
    }),
    status: "deprecated",
    deprecation_reason: opts.reason,
    superseded_by: opts.supersededBy ?? ((rest.superseded_by as string | null) ?? null),
    review_after: opts.reviewAfter ?? ((rest.review_after as Date | null) ?? null),
    updated_at: new Date(),
  });
  await upsert(next, {
    actor: opts.actor,
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    ...(opts.commit_sha !== undefined ? { commit_sha: opts.commit_sha } : {}),
  });
  return { id: next.id, status: String(next.status), version: next.version };
}

// ── curation: propose (never apply) deprecations ──────────────────────────────

export interface DeprecationCandidateDoc {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  superseded_by?: unknown;
  review_after?: unknown;
}

export interface DeprecationProposal {
  id: string;
  title: string;
  reason: string;
}

/**
 * Cheap token-set Dice similarity between two titles (no LLM): 2·|A∩B| / (|A|+|B|)
 * over lowercased alphanumeric tokens. 1 = identical token sets, 0 = disjoint.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9áéíóúñü]+/i)
        .filter(Boolean),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

/** Titles at or above this Dice similarity count as "very similar" (criterion c). */
export const TITLE_SIMILARITY_THRESHOLD = 0.8;

/**
 * Pure curation core over an in-memory list of decisions (oldest id first preferred).
 * Criteria — each active ADR (status not deprecated/superseded) is proposed when:
 *   (a) `superseded_by` is populated but the status was never flipped;
 *   (b) its `review_after` soft TTL has lapsed;
 *   (c) its title is very similar to a LATER ADR's (probable replacement).
 * Reasons are merged per id. This function only reports; it never mutates.
 */
export function proposeDeprecationsFrom(
  decisions: DeprecationCandidateDoc[],
  now: Date = new Date(),
): DeprecationProposal[] {
  const rows = decisions
    .map((d) => ({
      id: String(d.id ?? ""),
      title: String(d.title ?? ""),
      status: String(d.status ?? ""),
      superseded_by: (d.superseded_by as string | null | undefined) ?? null,
      review_after: d.review_after ?? null,
    }))
    .filter((d) => d.id);
  const active = rows.filter((d) => !INACTIVE_ADR_STATUSES.has(d.status));

  const reasons = new Map<string, { title: string; reasons: string[] }>();
  const add = (id: string, title: string, reason: string) => {
    const entry = reasons.get(id) ?? { title, reasons: [] };
    entry.reasons.push(reason);
    reasons.set(id, entry);
  };

  for (const d of active) {
    // (a) points at a replacement but was never flipped to superseded/deprecated.
    if (d.superseded_by) add(d.id, d.title, `superseded_by ${d.superseded_by} but status is '${d.status}'`);
    // (b) soft TTL lapsed.
    if (isReviewOverdue(d.review_after, now)) {
      const when = d.review_after instanceof Date ? d.review_after.toISOString().slice(0, 10) : String(d.review_after);
      add(d.id, d.title, `review_after lapsed (${when})`);
    }
    // (c) a LATER ADR has a very similar title (probable replacement).
    for (const later of rows) {
      if (later.id <= d.id) continue;
      if (titleSimilarity(d.title, later.title) >= TITLE_SIMILARITY_THRESHOLD) {
        add(d.id, d.title, `title very similar to later ADR ${later.id} ('${later.title}')`);
        break; // one similar-successor reason is enough
      }
    }
  }

  return [...reasons.entries()].map(([id, e]) => ({ id, title: e.title, reason: e.reasons.join("; ") }));
}

/** DB wrapper: list a project's decisions and run the pure curation core. */
export async function proposeDeprecations(project: string): Promise<DeprecationProposal[]> {
  await ensureMongoose();
  const rows = (await DecisionModel.find({ project }, { embedding: 0 })
    .sort({ id: 1 })
    .lean()) as unknown as DeprecationCandidateDoc[];
  return proposeDeprecationsFrom(rows);
}
