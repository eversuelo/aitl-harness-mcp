#!/usr/bin/env node
// Council E2E fixture: a host that NEVER answers valid JSON (every phase, every retry).
// Logs each invocation so the test can assert the retry budget (base + exactly 1 retry).
import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const phase = (input.match(/AITL-COUNCIL-PHASE:\s*(\w+)/) ?? [])[1] ?? "unknown";
if (process.env.AITL_COUNCIL_CALLS_FILE) {
  appendFileSync(process.env.AITL_COUNCIL_CALLS_FILE, `${phase} ${process.argv.slice(2).join(" ")}\n`);
}
process.stdout.write("Lo siento, prefiero explicarlo en prosa: { esto no es JSON válido…");
