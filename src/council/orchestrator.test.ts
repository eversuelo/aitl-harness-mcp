import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CouncilClientPort,
  CouncilVerdict,
  LabeledProposal,
  PlanCritique,
  PlanProposal,
} from "./ports.js";
import {
  type AuthoredProposal,
  type CouncilTelemetryStore,
  assignLabels,
  proposalsForCritic,
  runCouncil,
  splitCouncil,
} from "./orchestrator.js";

const plan = (title: string): PlanProposal => ({
  steps: [{ title, rationale: "" }],
  risks: [],
  assumptions: [],
  estimated_complexity: "low",
});

const identity = <T>(items: T[]): T[] => [...items];
const reverse = <T>(items: T[]): T[] => [...items].reverse();

// ── anonymization helpers ─────────────────────────────────────────────────────

test("assignLabels: labels A, B, C… follow the (injected) shuffle order and keep authorship internally", () => {
  const authored: AuthoredProposal[] = [
    { clientId: "codex", proposal: plan("p1") },
    { clientId: "claude-code", proposal: plan("p2") },
    { clientId: "antigravity", proposal: plan("p3") },
  ];
  const labeled = assignLabels(authored, reverse);
  assert.deepEqual(labeled.map((l) => l.label), ["A", "B", "C"]);
  assert.deepEqual(labeled.map((l) => l.clientId), ["antigravity", "claude-code", "codex"]);
  // The input array is not mutated (shuffle works on a copy).
  assert.deepEqual(authored.map((a) => a.clientId), ["codex", "claude-code", "antigravity"]);
});

test("proposalsForCritic: a critic NEVER sees its own proposal nor any authorship", () => {
  const labeled = assignLabels(
    [
      { clientId: "codex", proposal: plan("codex plan") },
      { clientId: "claude-code", proposal: plan("claude plan") },
      { clientId: "antigravity", proposal: plan("agy plan") },
    ],
    identity,
  );
  for (const critic of ["codex", "claude-code", "antigravity"]) {
    const ownLabel = labeled.find((l) => l.clientId === critic)?.label;
    const seen = proposalsForCritic(labeled, critic);
    assert.equal(seen.length, 2);
    assert.ok(!seen.some((s) => s.label === ownLabel), `${critic} saw its own label`);
    // Anonymized shape: label + proposal only — no clientId, no author anywhere.
    for (const s of seen) assert.deepEqual(Object.keys(s).sort(), ["label", "proposal"]);
    const wire = JSON.stringify(seen);
    assert.ok(!wire.includes(critic), `${critic} leaked into its own critique payload`);
  }
});

// ── council composition ───────────────────────────────────────────────────────

const seat = (id: string): CouncilClientPort => ({
  id,
  kind: "host",
  propose: async () => plan(id),
  critique: async () => [],
  judge: async () => ({ winner: null, synthesis: "", reasoning: "", per_proposal_scores: {} }),
});

test("splitCouncil: with ≥3 clients and no explicit judge, the LAST one judges only", () => {
  const { proponents, judge } = splitCouncil([seat("a"), seat("b"), seat("c")]);
  assert.deepEqual(proponents.map((p) => p.id), ["a", "b"]);
  assert.equal(judge.id, "c");
});

test("splitCouncil: exactly 2 clients without --judge → clear error asking for one", () => {
  assert.throws(() => splitCouncil([seat("a"), seat("b")]), /--judge/);
});

test("splitCouncil: an explicit judge keeps all clients proposing; judge must differ", () => {
  const { proponents, judge } = splitCouncil([seat("a"), seat("b")], seat("j"));
  assert.deepEqual(proponents.map((p) => p.id), ["a", "b"]);
  assert.equal(judge.id, "j");
  assert.throws(() => splitCouncil([seat("a"), seat("b")], seat("a")), /distinto de los proponentes/);
});

test("splitCouncil: duplicate seats are rejected", () => {
  assert.throws(() => splitCouncil([seat("a"), seat("a"), seat("j")]), /duplicado/);
});

// ── runCouncil anonymity property (fake ports, no hosts, no Mongo) ────────────

function nullTelemetry(): CouncilTelemetryStore {
  return {
    createRun: async () => "run-unit-0001",
    updateRun: async () => {},
    logEvent: async () => {},
    saveVerdictMemory: async (doc) => doc.slug,
  };
}

/** Fake port recording exactly what it was shown in each phase. */
function spySeat(id: string): CouncilClientPort & { sawCritique: LabeledProposal[][]; sawJudge: LabeledProposal[][] } {
  const sawCritique: LabeledProposal[][] = [];
  const sawJudge: LabeledProposal[][] = [];
  return {
    id,
    kind: "provider",
    sawCritique,
    sawJudge,
    async propose(): Promise<PlanProposal> {
      // Neutral content on purpose: the leak check below asserts the ONLY way an id
      // could reach a critic is the orchestrator attaching authorship (it must not).
      return plan("paso genérico");
    },
    async critique(anonProposals: LabeledProposal[]): Promise<PlanCritique[]> {
      sawCritique.push(anonProposals);
      return anonProposals.map((p) => ({
        target: p.label,
        findings: [],
        scores: { correctness: 3 },
        vote: anonProposals[0].label,
      }));
    },
    async judge(anonProposals: LabeledProposal[]): Promise<CouncilVerdict> {
      sawJudge.push(anonProposals);
      return {
        winner: anonProposals[0].label,
        synthesis: "s",
        reasoning: "r",
        per_proposal_scores: Object.fromEntries(anonProposals.map((p) => [p.label, 3])),
      };
    },
  };
}

test("runCouncil: during deliberation no critic receives its own proposal nor any client id", async () => {
  const a = spySeat("seat-alpha");
  const b = spySeat("seat-beta");
  const c = spySeat("seat-gamma");
  const j = spySeat("seat-judge");
  const result = await runCouncil({
    project: "proj",
    task: "diseñar el módulo X",
    proponents: [a, b, c],
    judge: j,
    telemetry: nullTelemetry(),
    shuffle: identity,
  });

  for (const critic of [a, b, c]) {
    const ownLabel = result.proposals.find((p) => p.client_id === critic.id)?.label;
    assert.equal(critic.sawCritique.length, 1);
    const seen = critic.sawCritique[0];
    assert.equal(seen.length, 2);
    assert.ok(!seen.some((s) => s.label === ownLabel));
    const wire = JSON.stringify(seen);
    for (const id of ["seat-alpha", "seat-beta", "seat-gamma"]) {
      assert.ok(!wire.includes(id), `authorship '${id}' leaked to critic ${critic.id}`);
    }
  }
  // The judge sees ALL proposals — anonymized too.
  assert.equal(j.sawJudge[0].length, 3);
  assert.ok(!JSON.stringify(j.sawJudge[0]).includes("seat-"));
  // Authorship only comes back AFTER deliberation, in the result.
  assert.deepEqual(result.authors, { A: "seat-alpha", B: "seat-beta", C: "seat-gamma" });
  assert.equal(result.verdict.winner, "A");
});

test("runCouncil: the judge must be distinct from every proponent", async () => {
  const a = spySeat("x");
  const b = spySeat("y");
  await assert.rejects(
    runCouncil({ project: "p", task: "t", proponents: [a, b], judge: a, telemetry: nullTelemetry() }),
    /distinto de los proponentes/,
  );
});
