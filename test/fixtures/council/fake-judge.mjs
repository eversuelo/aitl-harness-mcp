#!/usr/bin/env node
// Council E2E fixture: a judge impersonating `claude -p --output-format json` — the
// verdict travels inside the Claude JSON envelope (`result` + `usage`), so the test
// also exercises parseClaudeJson + token capture (thesis metric #7).
import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const phase = (input.match(/AITL-COUNCIL-PHASE:\s*(\w+)/) ?? [])[1] ?? "unknown";
if (process.env.AITL_COUNCIL_CALLS_FILE) {
  appendFileSync(process.env.AITL_COUNCIL_CALLS_FILE, `${phase} ${process.argv.slice(2).join(" ")}\n`);
}
if (phase !== "judge") {
  process.stdout.write(JSON.stringify({ result: `unexpected phase '${phase}'`, usage: {} }));
  process.exit(1);
}

const labels = [...new Set([...input.matchAll(/"label":\s*"([A-Z])"/g)].map((m) => m[1]))].sort();
const verdict = {
  winner: labels[0] ?? null,
  synthesis: "Plan combinado: tests de contrato primero, implementación mínima después.",
  reasoning: `La propuesta ${labels[0]} cubre verificabilidad; las críticas no señalan hallazgos major.`,
  per_proposal_scores: Object.fromEntries(labels.map((l, i) => [l, 4 - i * 0.5])),
};
process.stdout.write(
  JSON.stringify({
    result: JSON.stringify(verdict),
    usage: { input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, output_tokens: 5 },
  }),
);
