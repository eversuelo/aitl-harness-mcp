# ADR-0018 — Fase C — Orquestador flaco con sub-agentes paralelos

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Pilar 2 del plan. Faltaba la capacidad de descomponer una tarea grande y resolverla con varios sub-agentes en paralelo, sintetizando sus resultados, sobre el núcleo ya endurecido (enforcement H1, resiliencia H2, hidratación completa H3 incl. repo map real).

## Decision

Nuevo módulo src/orchestration/orchestrator.ts con orchestrate(master, project, opts). El orquestador es FLACO (no corre tool loop): (1) decide subtareas — explícitas (opts.tasks) o planificadas por el modelo (planSubtasks vía provider.complete, 'una por línea'), acotadas por maxSubagents (default 4); (2) lanza un runAgent por subtarea EN PARALELO con Promise.allSettled, cada uno con su ContextManager fresco por construcción (aislamiento de contexto), summarize:false por defecto; (3) sintetiza los resultados con provider.complete. Persiste como su propio run (harness_config.role='orchestrator'), emite eventos 'spawn' (por subtarea) y 'synthesis'; allSettled aísla fallos de sub-agente (se reportan como SubAgentOutcome status='error'). Expuesto en el CLI como 'aitl orchestrate <task>'.

## Consequences

El harness puede paralelizar trabajo con aislamiento de contexto y tolerancia a fallos parciales, reusando todo el núcleo (cada sub-agente hidrata contexto, enforces gates, resiste y puede reanudar). Verificado end-to-end contra Atlas con mocks: ruta explícita (2 sub-agentes, 1 done + 1 error aislado, síntesis, run orchestrator done, eventos spawn=2/synthesis=1), ruta de planificación (el modelo descompone en alpha/beta/gamma → 3 sub-agentes, síntesis), 0 residuos; typecheck+build limpios. Siguiente y último pilar: Fase D (SDD).
