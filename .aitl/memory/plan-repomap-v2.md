---
name: plan-repomap-v2
description: >-
  Plan repo map v2 (ADR-0070 proposed, doc PLAN-REPOMAP-V2.md): 7 brechas del
  mapa actual (métodos invisibles, refs por archivo, sin edges) y 5 fases hacia
  call graph + mapa de clases + get_impact anti-regresión integrado con hydrate
  y métrica de sesiones.
type: project
category: task
tags:
  - session-2026-07-11
  - plan
  - repomap
  - anti-regresion
  - adr-0070
  - 'component:src/repomap'
  - 'component:src/models'
version: 1
updated_at: 2026-07-11T23:34:18.744Z
branch: feat/harness-v2
commit_sha: 7bca160c7f6be4112677a147c745169bec547b14
---
PLAN REPO MAP V2 (2026-07-11, ADR-0070 status=proposed, documento canónico PLAN-REPOMAP-V2.md en la raíz del repo). Contexto de la sesión en [[siembra-skill-router-2026-07-11]].

BRECHAS del mapa actual (G1-G7, con evidencia): G1 métodos de clase invisibles para la heurística (RepoMap.build/render no son símbolos en este propio repo); G2 refs = Set plano por ARCHIVO, cap 50 (store.ts:62) → no hay quién-llama-a-quién; G3 sin line_start/end → no cruza con git diff; G4 sin parent/exported/signature; G5 el grafo del PageRank se tira (sin edges persistidos → sin consulta inversa); G6 cache mtime prometida en docstring pero build() = deleteMany+insertMany siempre; G7 wasm de tree-sitter sin empaquetar → siempre heurística. Evidencia viva: top PageRank = ruido (now/add/run/text de los modelos).

FASES: F1 símbolos ricos (posición, parent, exported, signature, kinds method/property; heurística scope-aware por llaves; wasm ts/tsx/js/py; fix mtime real). F2 symbol_edges {from, to, kind: calls|imports|extends|implements|instantiates, count} por (project, repo, branch); PageRank símbolo→símbolo; funciones principales = top PR ∪ entry points exported; compuestas = out-degree>0 en calls. F3 aitl repomap --classes (anidado en module map ADR-0053). F4 IMPACTO: clausura transitiva INVERSA (callers+importers); CLI aitl impact <sym|file|--diff> [--tests] + tool MCP get_impact; tests afectados (*.test.ts en el radio) → verify-cmd focalizado sugerido; evento impact_check. F5 integración con el plus del harness: hydrate gana fuente symbol-brief (símbolo mencionado → firma+callers/callees+ADRs components+memorias component:), capture-session taguea symbol:<name>, run doc gana symbols_touched[] + blast_radius, run-show reporta riesgo de regresión por sesión (tests del radio NO ejecutados — candidata a métrica #10 Tabla 4.3).

ORDEN: F1→F2→F4→F3→F5 (el valor anti-regresión antes que el render). Estimación 4-5 sesiones. Diseño conservador (sobre-avisar > callar una regresión), todo aditivo. Cada fase: tests en src/repomap/*.test.ts + ADR accepted referenciando el plan.
