---
name: raytracer-metrics-two-harness-bugs-2026-07-07
description: >-
  Dos bugs del harness confirmados por la medición C0/C2 del raytracer (fases
  0-3): MongoDB como dependencia dura que aborta runs, e hydrate que no inyecta
  ADRs recién creados. Ambos contaminan los datos de la tesis.
type: project
category: task
tags:
  - bug
  - hydrate
  - mongodb
  - metrics
  - raytracer
  - thesis
version: 1
updated_at: 2026-07-07T20:22:41.026Z
branch: feat/harness-v2
commit_sha: 9181c3b5de3f075572ee9de11bed5742506f64ae
---
La medición C0-bare vs C2-memory del raytracer (curso IA7200-L, fases 0-3, Sonnet 5, 2026-07-07) destapó **dos bugs del harness AITL-Harness-JS** que contaminan los datos de la tesis. Análisis forense en `thesis-harness/REPORTE-C0-C2-FASE3.md`.

**BUG A — MongoDB es dependencia dura que aborta el run entero.**
Cuando Mongo es inalcanzable, `aitl run`/`run-host` imprime "All MongoDB URIs failed… No hay MongoDB accesible" y sale ANTES de invocar al agente. Raíz: el hook global `preAction` en `src/cli.ts:45-64` hace `process.exit(1)` (línea 62); el allowlist `NO_DB_COMMANDS` (`src/cli.ts:41`) NO incluye `run` ni `run-host`. La conexión vive en `src/db/mongoose.ts:73-110` con `serverSelectionTimeoutMS: 8000` (líneas 28-32, NO 30s). **Ya existe el patrón degradado a copiar**: `executeOnHost` en `src/interactive/task.ts:109-137` corre el host SIN persistir cuando Mongo está caído. Impacto medido: en C0 fase 1, dos "gate=fail" del CSV fueron en realidad caídas de Mongo (no fallos del modelo), y el run que sí implementó la fase (`633383e0`, $1.27, 1.63M tok) se perdió del CSV; quedó registrado un run-fantasma barato ($0.23) que solo era un resumen de estado.
**Why:** un experimento de tesis no puede depender de una BD remota para no perder datos; falsos "fail" sesgan H1/H5/H6.
**How to apply:** meter `run`/`run-host` en modo degradado (probe backend, si Mongo cae correr igual y bufferizar/omitir telemetría con un warning) — no `process.exit`.

**BUG B — `hydrate` no inyecta ADRs recién creados (se queda pegado en 4).**
`hydrate.decisions` reportó 4 en las 4 fases de C2 aunque se crearon ADR-0005 y 0006 entre fases. Raíz doble en `src/memory/lifecycle.ts`, bloque decisions de `hydrate()` (líneas 252-283): (1) tope duro `.slice(0,4)` (línea 276) → el contador nunca supera 4; (2) `relevant()` (líneas 34-84) es vector→text→recency y RETORNA en el primer tier no vacío, así que el tier de recencia —el único que sube ADRs nuevos por `updated_at`— nunca se alcanza si textSearch trae algo. `HydrateOpts.limit` solo aplica a memory (línea 248), no a decisions (fetch fijo 8, render fijo 4). NO es filtro por branch (hydrate filtra solo por `project`). Ya estaba anotado en `AITL-Harness-JS/TODO.md:10-12`.
**Why:** rompe H3/H7 (memoria/recuperación selectiva): la condición C2 no "ve" las decisiones que ella misma acaba de tomar.
**How to apply:** parametrizar/subir el tope de render y el fetch, y unir siempre una pasada de recencia (los N ADRs más nuevos) antes de `partitionDecisions`.

Este trabajo se planificó en `thesis-harness/PLAN-REPARACION-HARNESS-METRICAS.md` (bugs + refactor de métricas del raytracer: rama única + tags, evidencias PPM→PNG, catálogo M1-M61 → set mínimo). Tras aprobar el enfoque: ADR aitl-js 0060 (fixes del harness) + ADR aitl-raytracer 0007 (metodología de métricas). Ledger aitl-js next-free 0060 (ver [[session-harness-v2-plan-2026-07-06]]). Detalle del experimento en [[fase3-forensic-lessons-raytracer]].
