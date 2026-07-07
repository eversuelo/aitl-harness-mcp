import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCritiques, parseProposal, parseVerdict } from "./adapters.js";
import { CouncilFormatError } from "./ports.js";

test("parseProposal: extracts the balanced JSON object out of prose/fences and validates it", () => {
  // The balanced walker takes the FIRST object and ignores trailing prose — even prose
  // containing more braces (the greedy-regex failure mode found live with gemma-4).
  const text = [
    "Claro, aquí está mi plan:",
    "```json",
    '{"steps":[{"title":"paso 1","rationale":"porque sí"}],"risks":["r1"],"assumptions":[],"estimated_complexity":"high"}',
    "```",
    "¿Algo más? {puedo dar más detalles}",
  ].join("\n");
  const p = parseProposal(text);
  assert.equal(p.steps[0].title, "paso 1");
  assert.equal(p.estimated_complexity, "high");
});

test("parseProposal: schema violations throw CouncilFormatError citing the field", () => {
  const bad = '{"steps":[],"risks":[],"assumptions":[],"estimated_complexity":"enorme"}';
  assert.throws(() => parseProposal(bad), (err: unknown) => {
    assert.ok(err instanceof CouncilFormatError);
    assert.match(err.message, /proposal schema/);
    return true;
  });
  assert.throws(() => parseProposal("sin json aquí"), CouncilFormatError);
  assert.throws(() => parseProposal("{ roto"), CouncilFormatError);
});

test("parseCritiques: fans the single vote out into every PlanCritique", () => {
  const reply = JSON.stringify({
    critiques: [
      { target: "A", findings: [{ severity: "major", comment: "sin rollback" }], scores: { correctness: 2 } },
      { target: "C", findings: [], scores: { correctness: 4 } },
    ],
    vote: "C",
  });
  const critiques = parseCritiques(reply);
  assert.deepEqual(critiques.map((c) => c.target), ["A", "C"]);
  assert.deepEqual(critiques.map((c) => c.vote), ["C", "C"]);
  assert.equal(critiques[0].findings[0].severity, "major");
});

test("parseCritiques: out-of-range scores and missing vote are format errors", () => {
  assert.throws(
    () => parseCritiques('{"critiques":[{"target":"A","findings":[],"scores":{"correctness":9}}],"vote":"A"}'),
    /critique schema/,
  );
  assert.throws(() => parseCritiques('{"critiques":[{"target":"A","findings":[],"scores":{}}]}'), /critique schema/);
});

test("parseVerdict: accepts winner null and validates the shape", () => {
  const v = parseVerdict('{"winner":null,"synthesis":"s","reasoning":"r","per_proposal_scores":{"A":3.5}}');
  assert.equal(v.winner, null);
  assert.equal(v.per_proposal_scores.A, 3.5);
  assert.throws(() => parseVerdict('{"winner":"A","synthesis":"s"}'), /verdict schema/);
});
