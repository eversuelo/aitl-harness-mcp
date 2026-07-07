/**
 * Plan-council rubric (ADR-0003 v1) — the FIXED criteria every critic scores 0–5,
 * and the pure, deterministic aggregation of those scores into one number per proposal.
 *
 * The weights sum to 1. Aggregation is a weighted mean of per-criterion means: for each
 * proposal, each criterion averages the scores all critics gave it, then the criterion
 * means combine by weight. Criteria nobody scored are excluded and the remaining weights
 * renormalized (a critic that omits `simplicity` should not zero the proposal). Scores
 * for keys outside the rubric are ignored. Pure function — unit-tested in rubric.test.ts.
 */

import type { PlanCritique } from "./ports.js";

/** Criterion → weight. Weights sum to 1 (asserted by test). */
export const RUBRIC_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  correctness: 0.3,
  completeness: 0.2,
  risk: 0.2,
  simplicity: 0.15,
  verifiability: 0.15,
});

export const RUBRIC_CRITERIA: readonly string[] = Object.freeze(Object.keys(RUBRIC_WEIGHTS));

export interface ProposalScore {
  /** Mean score per rubric criterion (only criteria at least one critic scored). */
  criteria: Record<string, number>;
  /** Weighted mean over the scored criteria (0–5), weights renormalized over those present. */
  total: number;
  /** How many critiques contributed at least one rubric score. */
  critiques: number;
}

/**
 * Aggregate the critics' scores into one deterministic score per proposal label.
 * Input order does not matter; the result contains every label that received ≥1 critique.
 */
export function aggregateScores(critiques: PlanCritique[]): Record<string, ProposalScore> {
  // label → criterion → list of scores
  const buckets = new Map<string, Map<string, number[]>>();
  const counted = new Map<string, number>();
  for (const c of critiques) {
    let perCriterion = buckets.get(c.target);
    if (!perCriterion) {
      perCriterion = new Map();
      buckets.set(c.target, perCriterion);
    }
    let contributed = false;
    for (const criterion of RUBRIC_CRITERIA) {
      const v = c.scores[criterion];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const clamped = Math.min(5, Math.max(0, v));
      const list = perCriterion.get(criterion) ?? [];
      list.push(clamped);
      perCriterion.set(criterion, list);
      contributed = true;
    }
    if (contributed) counted.set(c.target, (counted.get(c.target) ?? 0) + 1);
    else counted.set(c.target, counted.get(c.target) ?? 0);
  }

  const out: Record<string, ProposalScore> = {};
  for (const [label, perCriterion] of buckets) {
    const criteria: Record<string, number> = {};
    let weighted = 0;
    let weightSum = 0;
    for (const criterion of RUBRIC_CRITERIA) {
      const scores = perCriterion.get(criterion);
      if (!scores?.length) continue;
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      criteria[criterion] = mean;
      weighted += RUBRIC_WEIGHTS[criterion] * mean;
      weightSum += RUBRIC_WEIGHTS[criterion];
    }
    out[label] = {
      criteria,
      total: weightSum > 0 ? weighted / weightSum : 0,
      critiques: counted.get(label) ?? 0,
    };
  }
  return out;
}
