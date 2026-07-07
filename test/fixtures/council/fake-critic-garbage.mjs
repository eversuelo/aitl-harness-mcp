#!/usr/bin/env node
// Council E2E fixture: proposes correctly but emits garbage in the CRITIQUE round —
// after the single retry it must become a no-vote WITHOUT breaking quorum (its own
// proposal already survived the propose round).
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
      steps: [{ title: "Refactor incremental", rationale: "menos riesgo por paso" }],
      risks: [],
      assumptions: [],
      estimated_complexity: "medium",
    }),
  );
} else {
  process.stdout.write("¡JSON! ¿Para qué? [aquí iba una crítica en prosa]");
}
