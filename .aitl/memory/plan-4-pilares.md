---
name: plan-4-pilares
description: Plan del harness (4 pilares + endurecimiento del núcleo) y estado de avance
type: project
category: task
tags:
  - plan
  - roadmap
  - harness
  - memory
  - skills
  - enforcement
  - resilience
  - hydration
  - repomap
  - orchestration
  - sdd
version: 1
updated_at: 2026-06-24T14:25:42.304Z
---
Plan del harness (proyecto aitl-js). REORDENADO 2026-06-24: el endurecimiento del NÚCLEO (enforcement + resiliencia + hidratación) fue antes de la orquestación. Todo sobre runAgent/MemoryStore/LangGraph + colecciones agents/skills (nada de Engram).

HECHO:
- Fase A — Ciclo de vida de memoria (Pilar 1): hydrate + summarizeSession + auto-save. ✅ (ADR 0012)
- Fase B — Router de skills (Pilar 3): selección léxica→recencia + re-rank semántico; evento skills_route. ✅ (ADR 0013)
- Núcleo H1 — Enforcement determinista + auditoría de gates dentro de runAgent. ✅ (ADR 0014)
- Núcleo H2 — Resiliencia del loop: retries, [tool error], estado 'error', verify, resume por transcript. ✅ (ADR 0015)
- Núcleo H3 — Hidratación completa: memoria + decisiones + conventions + repomap. ✅ (ADR 0016)
- Repo map operativo — extractor heurístico por regex (fallback de tree-sitter); 230 símbolos reales del repo aitl-js. ✅ (ADR 0017)
- Fase C — Orquestador flaco + sub-agentes paralelos (Pilar 2): src/orchestration/orchestrator.ts, planificación o tareas explícitas, Promise.allSettled con ContextManager fresco por sub-agente, síntesis, eventos spawn/synthesis, CLI 'aitl orchestrate'. ✅ (ADR 0018)

SIGUIENTE (último pilar):
- Fase D — SDD (Pilar 4): pipeline de fases (cada una un sub-agente de C), artefactos persistidos (propuesta/specs/design/tasks), subcomandos aitl sdd-new|continue|apply|verify.

Clave canónica del proyecto: `aitl-js` (ver memoria project-identity).
