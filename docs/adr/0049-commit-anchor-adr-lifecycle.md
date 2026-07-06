# ADR-0049 — Memoria y ADRs anclados a commit + ciclo de vida de ADRs + branch sync --reindex

- **Status:** Accepted
- **Date:** 2026-07-06

## Context
Dos brechas de trazabilidad: (1) la memoria y las decisiones solo estampaban
`branch`, sin SHA — "sintetizar la memoria a la altura del commit" era imposible y
la síntesis ni siquiera propagaba actor/branch; (2) el esquema de decisiones no
tenía ciclo de vida (enum proposed|accepted|superseded, sin motivo de deprecación,
sin TTL), así que el conocimiento obsoleto seguía entrando al preámbulo de hydrate
para siempre. Además, un merge a la rama base no disparaba reindexado del repo.

## Decision
1. **F2 commit-anchor**: campo `commit_sha` en memory y decisions;
   `headSha()`/`resolveRef()` en `util/git.ts` (read-only); estampado en
   `archiveAndBumpVersion` y resuelto por defecto en
   `MemoryStore.upsertMemory`/`ADRStore.upsert` (explícito > default vivo) — cubre
   CLI, MCP y API de una vez; el synthesizer propaga `{actor, branch, commit_sha}`
   y `aitl synthesize --at <ref>` estampa un ref arbitrario (solo provenance).
2. **F4 ciclo de vida**: enum `status` + `"deprecated"`; campos
   `deprecation_reason`, `superseded_by`, `review_after` (TTL SUAVE: al vencer se
   excluye del preámbulo y se lista aparte como "ADRs pendientes de revisión";
   NUNCA se borra), `components[]` (para module-brief); tool MCP
   `deprecate_decision` + CLI `aitl adr deprecate` (re-upsert por el camino normal
   de versionado); hydrate excluye deprecated/superseded/vencidos;
   `proposeDeprecations` SOLO propone candidatos (superseded_by poblado /
   review_after vencido / similitud de títulos Dice, sin LLM); badges de estado en
   DecisionsView.
3. **`aitl branch sync --reindex`**: guarda el `head_sha` de la rama base y, si
   avanzó, dispara el indexador maestro; segunda corrida = no-op.
4. Fix hallado por el E2E: `consequences` pasó de `required:true` a `default:""` —
   Mongoose rechaza `""` en String required (mismo gotcha que ADR-0043) y la
   deprecación fallaba sobre docs legados sin el campo.

## Consequences
- Cada escritura de memoria/decisión queda anclada a branch+commit: provenance
  citable en la tesis y síntesis fechada "a la altura del commit".
- El conocimiento caduca con gobernanza: deprecación con motivo y TTL suave
  auditables; el preámbulo de hydrate deja de arrastrar decisiones muertas sin
  perder el registro histórico (append-only).
- verify 133/133 (15 tests nuevos). E2E vivo: `commit_sha == git rev-parse HEAD`;
  deprecate → v2 excluida de hydrate; review_after vencido solo como "pendiente de
  revisión"; `branch sync --reindex` reindexa (622 símbolos, 25 ADRs) y luego no-op.
- Nota: `aitl hydrate` fuera de un hook espera EOF de stdin; invocar con stdin
  cerrado en scripts. El hook git post-merge lo instalará `aitl init` (P5).
