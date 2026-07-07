import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanCritique } from "./ports.js";
import { RUBRIC_CRITERIA, RUBRIC_WEIGHTS, aggregateScores } from "./rubric.js";

const critique = (target: string, scores: Record<string, number>, vote = target): PlanCritique => ({
  target,
  findings: [],
  scores,
  vote,
});

const FULL = { correctness: 4, completeness: 4, risk: 3, simplicity: 5, verifiability: 4 };

test("rubric: weights cover the five criteria and sum to 1", () => {
  assert.deepEqual(
    [...RUBRIC_CRITERIA].sort(),
    ["completeness", "correctness", "risk", "simplicity", "verifiability"],
  );
  const sum = Object.values(RUBRIC_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}, expected 1`);
});

test("aggregateScores: weighted mean of per-criterion means, deterministic", () => {
  const critiques = [
    critique("A", { correctness: 4, completeness: 4, risk: 3, simplicity: 5, verifiability: 4 }),
    critique("A", { correctness: 2, completeness: 3, risk: 5, simplicity: 1, verifiability: 2 }),
  ];
  const res = aggregateScores(critiques);
  assert.deepEqual(res.A.criteria, { correctness: 3, completeness: 3.5, risk: 4, simplicity: 3, verifiability: 3 });
  // 0.3*3 + 0.2*3.5 + 0.2*4 + 0.15*3 + 0.15*3 = 3.3
  assert.ok(Math.abs(res.A.total - 3.3) < 1e-9, `total ${res.A.total}`);
  assert.equal(res.A.critiques, 2);
});

test("aggregateScores: input order does not matter (pure/deterministic)", () => {
  const a = critique("A", FULL);
  const b = critique("B", { correctness: 1, completeness: 2, risk: 3, simplicity: 4, verifiability: 5 });
  const c = critique("A", { correctness: 5, completeness: 5, risk: 5, simplicity: 5, verifiability: 5 });
  assert.deepEqual(aggregateScores([a, b, c]), aggregateScores([c, a, b]));
});

test("aggregateScores: missing criteria are excluded and weights renormalized", () => {
  const res = aggregateScores([critique("A", { correctness: 4 })]);
  assert.deepEqual(res.A.criteria, { correctness: 4 });
  assert.equal(res.A.total, 4); // (0.3*4)/0.3 — a missing 'simplicity' must not zero the plan
});

test("aggregateScores: keys outside the rubric are ignored", () => {
  const res = aggregateScores([critique("A", { correctness: 4, vibes: 5, elegancia: 0 })]);
  assert.deepEqual(Object.keys(res.A.criteria), ["correctness"]);
  assert.equal(res.A.total, 4);
});

test("aggregateScores: out-of-range values are clamped to [0,5]", () => {
  const res = aggregateScores([critique("A", { correctness: 7, risk: -2 })]);
  assert.deepEqual(res.A.criteria, { correctness: 5, risk: 0 });
});

test("aggregateScores: no critiques → empty result; per-label independence", () => {
  assert.deepEqual(aggregateScores([]), {});
  const res = aggregateScores([critique("A", FULL), critique("B", { correctness: 1 })]);
  assert.equal(res.B.total, 1);
  assert.ok(res.A.total > res.B.total);
});
