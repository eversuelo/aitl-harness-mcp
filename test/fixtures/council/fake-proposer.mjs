#!/usr/bin/env node
// Council E2E fixture: a well-behaved host. Reads the prompt on stdin, detects the
// phase from the AITL-COUNCIL-PHASE marker, and emits canned STRICT JSON on stdout.
// When AITL_COUNCIL_CALLS_FILE is set, appends "<phase> <argv>" per invocation so the
// test can assert invocation counts and the read-only argv the harness passed.
import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const phase = (input.match(/AITL-COUNCIL-PHASE:\s*(\w+)/) ?? [])[1] ?? "unknown";
if (process.env.AITL_COUNCIL_CALLS_FILE) {
  appendFileSync(process.env.AITL_COUNCIL_CALLS_FILE, `${phase} ${process.argv.slice(2).join(" ")}\n`);
}

if (phase === "propose") {
  process.stdout.write(
    JSON.stringify({
      steps: [
        { title: "Escribir tests de contrato", rationale: "fijan el comportamiento esperado" },
        { title: "Implementar el módulo", rationale: "mínimo que pase los tests" },
      ],
      risks: ["el esquema puede cambiar"],
      assumptions: ["Node 20 disponible"],
      estimated_complexity: "low",
    }),
  );
} else if (phase === "critique") {
  // The labels of the FOREIGN proposals arrive inside the prompt JSON.
  const labels = [...new Set([...input.matchAll(/"label":\s*"([A-Z])"/g)].map((m) => m[1]))];
  process.stdout.write(
    JSON.stringify({
      critiques: labels.map((label) => ({
        target: label,
        findings: [{ severity: "minor", comment: `la propuesta ${label} no menciona rollback` }],
        scores: { correctness: 4, completeness: 4, risk: 3, simplicity: 5, verifiability: 4 },
      })),
      vote: labels[0],
    }),
  );
} else {
  process.stdout.write(`unexpected phase '${phase}'`);
  process.exit(1);
}
