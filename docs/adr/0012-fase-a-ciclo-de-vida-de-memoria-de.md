# ADR-0012 — Fase A — Ciclo de vida de memoria de sesión en runAgent

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Pilar 1 del plan. Una sesión de agente debe hidratar contexto al inicio y comprimir su transcripción en memoria durable al cierre, sin mem_save explícito, reusando Classifier/Synthesizer/embedOne/ContextManager.

## Decision

Nuevo módulo src/memory/lifecycle.ts con hydrate(project, prompt) y summarizeSession(project, runId, convo), cableado en runAgent (src/orchestration/graph.ts): hidrata antes del loop, resume después; ambos best-effort. Flags opt-out hydrate/summarize (default true), campo summary_slug en el resultado, eventos hydrate/session_summary en el schema. relevantMemory usa cascada vector → texto → recencia (ver [ADR-0010]) para funcionar aunque Atlas no tenga índice vectorial.

## Consequences

Verificado end-to-end contra Atlas con provider mock: hidratación inyecta memoria previa, resumen auto-clasificado (category decision), eventos emitidos, opt-out respetado, sin residuos, typecheck+build limpios. Habilita Fases B/C/D. (Renumerado desde un 0003 escrito por error bajo AITL-Harness-JS.)
