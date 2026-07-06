---
name: session-graph-run-artifacts-0035
description: >-
  ADR-0035: grafo por sesión — capture-session extrae artifacts
  (ADRs/memorias/prompts) del transcript y los liga al run; builder
  src/graph/session.ts + GET /api/runs/:id/graph + SessionGraphView en la
  pestaña Runs.
type: project
category: decision
tags:
  - adr-0035
  - session-graph
  - runs
  - artifacts
  - knowledge-graph
  - claude-code
  - 'component:src/graph'
  - 'component:src/context'
  - 'component:src/server'
  - 'component:web'
version: 1
updated_at: 2026-06-29T16:12:44.809Z
branch: master
---
ADR-0035 (2026-06-29, accepted, verificado). Liga cada run a los artefactos durables que produjo y los grafica. Continúa [[capture-session-records-runs-0034]] / [[host-token-metrics-spec-sdd-0034]].

CLAVE: el transcript JSONL de Claude Code registra las llamadas tool_use MCP con sus inputs → linkage preciso y retroactivo (no depende de ventanas temporales).

CAMBIOS:
- src/context/capture.ts: `parseTranscript` extrae SessionArtifacts{decisions(ids de record_decision), memories(slugs de write_memory), prompts(title/snippet de record_prompt), interventions} por sufijo de nombre del tool_use; dedupe. `captureSession` persiste run.artifacts. CaptureResult+artifacts; CLI capture-session imprime artifacts=[ADRs n, mem n, prompts n].
- src/graph/session.ts: `assembleSessionGraph(run, links)` puro (run node + nodos producidos + edges 'produced' + reusa [[links]] memory↔memory). `sessionGraph(db,project,runId,{temporal})` resuelve inclusión: artifacts (por id/slug) + prompts.run_id + memorias tag run:<id8>/slug session-<id8>|spec-synthesis-<id8>; temporal (created_at en [started,ended]) OPT-IN. Cada nodo lleva basis(artifact|run_id|tag|temporal).
- src/graph/types.ts: NodeKind +run|prompt; EdgeKind +produced.
- src/server/api.ts: GET /api/runs/:id/graph?project=&temporal=1.
- web: api.sessionGraph; NODE_FILL/KIND_LABEL +run(#0f172a)|prompt(#64748b); SessionGraphView en el detalle de Runs (SVG via computeLayout + badges de artefactos + toggle 'ventana temporal'; nodos temporales con opacidad menor).

USO: el grafo se puebla al correr `aitl capture-session --session <id> --transcript <jsonl>`; re-correr refresca. Para auto, hook Stop (ver README). 

Ejemplo run d4227793 (esta sesión): artifacts decisions=[0034,0035], memories=[host-token-metrics-spec-sdd-0034, capture-session-records-runs-0034, session-graph-run-artifacts-0035, session-...].

Verificado: typecheck core+web, build, vite build, 46/46 tests (2 nuevos assembleSessionGraph). Pendiente: run-host puro no captura transcript (artifacts vacíos → solo run_id/tags/temporal); ended_at snapshot trunca temporal (re-capturar corrige). next-free ADR 0036.
