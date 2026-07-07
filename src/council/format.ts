/**
 * Council result rendering — pure text builders shared by `aitl council` (CLI) and the
 * interactive panel's Task branch, so both surfaces print the identical summary:
 * proposals (anonymous labels, de-anonymized authors AFTER deliberation) → weighted
 * rubric table → no-votes → verdict.
 *
 * `buildWinnerDelegationPrompt` turns a verdict's winning proposal into the prompt the
 * user can delegate to a host (`run-host`) — the "ejecutar el plan ganador" handoff.
 */

import type { CouncilResult } from "./orchestrator.js";

/** Human summary of a council run, one string per output line (print verbatim). */
export function formatCouncilSummary(result: CouncilResult): string[] {
  const lines: string[] = [];
  lines.push(
    `council run=${result.run_id ?? "(sin persistir)"} propuestas=${result.proposals.length} ` +
      `juez=${result.judge_id} rondas=${result.rounds} tokens=${result.token_usage.input}+${result.token_usage.output} ` +
      `duración=${result.duration_ms}ms`,
  );
  lines.push("", "Propuestas:");
  for (const p of result.proposals) {
    lines.push(`  [${p.label}] ${p.client_id} — ${p.proposal.steps.length} pasos, complejidad ${p.proposal.estimated_complexity}`);
    for (const s of p.proposal.steps) lines.push(`      • ${s.title}`);
  }
  const labels = result.proposals.map((p) => p.label);
  const cell = (v: number | undefined): string => (v === undefined ? "  —  " : v.toFixed(2).padStart(5));
  const rows = Object.entries(result.rubric.weights).map(([c, w]) => [`${c} (${w})`, c] as const);
  const width = Math.max("criterio".length, ...rows.map(([head]) => head.length)) + 2;
  lines.push("", "Rúbrica (0–5, media ponderada de las críticas):");
  lines.push(`  ${"criterio".padEnd(width)}${labels.map((l) => l.padStart(6)).join("")}`);
  for (const [head, criterion] of rows) {
    const row = labels.map((l) => ` ${cell(result.rubric.scores[l]?.criteria[criterion])}`).join("");
    lines.push(`  ${head.padEnd(width)}${row}`);
  }
  lines.push(`  ${"TOTAL".padEnd(width)}${labels.map((l) => ` ${cell(result.rubric.scores[l]?.total)}`).join("")}`);
  if (result.no_votes.length) {
    lines.push("", "Sin-voto:");
    for (const nv of result.no_votes) lines.push(`  ${nv.client_id} (${nv.phase} r${nv.round}): ${nv.error}`);
  }
  const v = result.verdict;
  lines.push("", `Veredicto (juez ${result.judge_id}):`);
  lines.push(`  Ganador: ${v.winner ? `${v.winner} — ${result.authors[v.winner]}` : "ninguno"}`);
  lines.push(`  Síntesis: ${v.synthesis}`);
  lines.push(`  Razonamiento: ${v.reasoning}`);
  if (result.memory_slug) lines.push(`  Memoria design: ${result.memory_slug}`);
  return lines;
}

/**
 * Prompt to EXECUTE the winning plan on a host, or null when the council produced no
 * winner. Carries the task, the winning steps (with rationale), its risks/assumptions
 * and the judge's synthesis, so the executing host sees the full deliberation outcome.
 */
export function buildWinnerDelegationPrompt(result: CouncilResult): string | null {
  const winner = result.verdict.winner;
  if (!winner) return null;
  const entry = result.proposals.find((p) => p.label === winner);
  if (!entry) return null;
  const lines: string[] = [
    `# Plan aprobado por el consejo${result.run_id ? ` (run ${result.run_id})` : ""}`,
    "",
    "## Tarea original",
    result.task,
    "",
    `## Plan ganador (${winner} — ${result.authors[winner] ?? entry.client_id})`,
  ];
  for (const [i, step] of entry.proposal.steps.entries()) {
    lines.push(`${i + 1}. ${step.title}${step.rationale ? ` — ${step.rationale}` : ""}`);
  }
  if (entry.proposal.risks.length) {
    lines.push("", "## Riesgos señalados");
    for (const r of entry.proposal.risks) lines.push(`- ${r}`);
  }
  if (entry.proposal.assumptions.length) {
    lines.push("", "## Supuestos");
    for (const a of entry.proposal.assumptions) lines.push(`- ${a}`);
  }
  if (result.verdict.synthesis.trim()) {
    lines.push("", "## Síntesis del juez", result.verdict.synthesis.trim());
  }
  lines.push(
    "",
    "## Instrucciones",
    "Ejecuta este plan paso a paso en el repositorio actual. Respeta los riesgos y supuestos",
    "señalados; si un paso resulta inviable, explica por qué y propone la corrección mínima.",
  );
  return lines.join("\n");
}
