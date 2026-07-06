# ADR-0035 — Grafo por sesión: ligar un run a los ADRs/memorias/prompts que produjo (run↔artefactos)

- **Status:** accepted
- **Date:** 2026-06-29

## Context

Tras ADR-0034 (runs con tokens + capture-session que registra runs humanos), el usuario pidió ligar cada run a las ADRs, prompts y memorias escritas en esa sesión, y un grafo de lo trabajado por sesión. La colección `prompts` ya tenía `run_id`, pero memorias y ADRs no tienen linkage de sesión, y para una sesión de Claude Code conducida por humano el harness no conoce el run-id al momento de cada llamada MCP. Sin embargo, el transcript JSONL de Claude Code SÍ registra las llamadas tool_use (mcp__aitl-js__record_decision/write_memory/record_prompt) con sus inputs (id/slug/title) → fuente de verdad precisa y retroactiva.

## Decision

Aditivo, parity-neutral. (1) EXTRACCIÓN DE ARTEFACTOS: `parseTranscript` (src/context/capture.ts) ahora extrae `artifacts{decisions[],memories[],prompts[],interventions}` de los tool_use por sufijo de nombre (record_decision→id, write_memory→slug, record_prompt→title/snippet, record_human_intervention→count); `captureSession` los persiste en `run.artifacts`. (2) BUILDER DE GRAFO: src/graph/session.ts con `assembleSessionGraph` (puro, testeado) + `sessionGraph(db,project,runId,{temporal})`. Linkage por defecto SOLO explícito: artifacts (ADRs por id, memorias por slug), prompts por run_id, memorias por tag `run:<id8>`/slug `session-<id8>`/`spec-synthesis-<id8>`. Fallback temporal (created_at en [started,ended]) es opt-in (?temporal=1) para no meter ruido. Cada nodo lleva `basis` (artifact|run_id|tag|temporal). Reusa memory↔memory [[links]]. (3) TIPOS: NodeKind +run|prompt, EdgeKind +produced (src/graph/types.ts). (4) API: GET /api/runs/:id/graph?project=&temporal=. (5) UI: cliente api.sessionGraph; NODE_FILL/KIND_LABEL +run|prompt; SessionGraphView dentro del detalle de Runs (SVG reusando computeLayout + lista de artefactos como badges + toggle temporal; nodos temporales con opacidad menor).

## Consequences

Cada run de Claude Code capturado queda ligado, de forma precisa y retroactiva, a los ADRs/memorias/prompts que produjo — visible como grafo en la pestaña Runs. Re-correr `aitl capture-session` con el mismo --session refresca artifacts+tokens. Verificado: typecheck core+web verdes, build verde, vite build, 46/46 tests (2 nuevos de assembleSessionGraph). Limitaciones: si el run no se capturó vía transcript (p. ej. run-host puro) los artifacts vienen vacíos y solo hay prompts.run_id + tags + temporal; el linkage temporal sufre si ended_at es un snapshot a mitad de sesión (re-capturar lo corrige). CLAUDE.md ledger → próximo ADR libre 0036.
