---
name: session-2026-06-28-foundation
description: >-
  HANDOFF retomar-mañana: sesión fundación Ciclo 01. Hecho: Fase 0 ledger
  (0001-0025), graphify desacoplado (ADR-0025), grafo en UI. PRÓXIMO: Fase 1 DoD
  (next-free 0026, sin pinnear) esperando luz verde. Rama ciclo-01/foundation.
type: project
tags:
  - session
  - handoff
  - resume
  - ciclo-01
  - foundation
  - graphify
  - graph-ui
  - adr-ledger
version: 1
updated_at: 2026-06-28T08:31:20.524Z
---
## HANDOFF — retomar mañana (sesión fundación Ciclo 01)

### ▶ PRÓXIMO PASO (esperando luz verde del usuario)
Fase 1 del brief: diseñar **docs/ciclo-01-definition-of-done.md**.
- Numeración SIN pinnear; con ADR-0025 ya tomado, el corte arranca en **next-free 0026** (C1=0026...).
- Alcance del corte: C1 models+binding, C2 actor, C3 git snapshot, C4 traza+task, C6 ShellTool+concurrencia, E1 Role, E2 modos, E3 catálogo (3 roles). Deferido: C5, E4, E5, E6, E7, E8.
- Incluir los 5 huecos: (1) enganche de roles al loop [gate reusa ToolRegistry; review/pair = hooks nuevos], (2) task se materializa también en runAgent, (3) C3 necesita project-registry (remote->project), (4) actor por git/os en stdio, (5) la traza persiste el binding runAgent<->rol<->model.
- pair solo en QA pero GENÉRICO (vía triggers). Incluir escena DoD + lista de ADRs esperados (sin números).
- El brief manda stop-and-report tras Fase 1 antes del BUILD (Fase 2).

### Cómo retomar
- Rama git: **ciclo-01/foundation** (árbol limpio, sin push a master). Commits: 1e9bb81, 7619afc, ad9cc96.
- Hidratar este contexto: search_memory project=aitl-js "fundación ciclo 01".
- Verificar next-free SIEMPRE antes de registrar ADR (list_decisions). Hoy: ledger 0001-0025, next-free 0026.

### Hecho en esta sesión
- Fase 0: ledger reconciliado (CLAUDE.md/TODO.md/docs/adr/README.md/backlog). Commit 1e9bb81.
- graphify desacoplado -> src/graph/ (port GraphSource). [[ADR-0025]]. Commit 7619afc. 23 tests verdes.
- Grafo en la UI: GET /api/graph + tab Graph (SVG force-directed). Commit ad9cc96.
- Skill global adr-ledger-reconcile registrada (__global__). EVAL-1/2 en docs/tareas-eval-0038-0039.md.

### Fases del brief pendientes tras Fase 1
Fase 2 BUILD (models/tasks/actor/doctor/roles + ADRs next-free), Fase 3 README dev-friendly, Fase 4 docs/deploy-mcp-cloud.md.
