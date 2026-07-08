# ADR-0060 — Modo degradado sin Mongo en run-host + hydrate que inyecta ADRs frescos (fixes destapados por la medición del raytracer)

- **Status:** accepted
- **Date:** 2026-07-07
- **Components:** src/cli.ts, src/hosts/run.ts, src/memory/lifecycle.ts

## Context

La medición C0-bare vs C2-memory del raytracer (curso IA7200-L, fases 0-3, Sonnet 5, 2026-07-07; forense en thesis-harness/REPORTE-C0-C2-FASE3.md) destapó dos bugs del harness que contaminan los datos de la tesis. BUG A: MongoDB es dependencia dura — el hook preAction (src/cli.ts) hacía process.exit(1) cuando Atlas era inalcanzable, abortando run/run-host ANTES de invocar al agente; en el curso eso hizo que caídas de Mongo se contaran como gate=fail (no fallo del modelo) y que el trabajo real de una fase se perdiera del CSV (run-fantasma en C0 fase 1). BUG B: hydrate se quedaba pegado en 4 decisiones — src/memory/lifecycle.ts tenía tope duro .slice(0,4) y relevant() (vector→text→recency) retorna en el primer tier no vacío, así que el tier de recencia (único que sube ADRs nuevos por updated_at) nunca corría; la condición C2 no veía los ADRs que ella misma acababa de crear (viola H3/H7). Ya estaba anotado en TODO.md:10-12.

## Decision

(A) run-host degrada en vez de abortar: DEGRADABLE_COMMANDS={run-host} en src/cli.ts; el preAction, ante Mongo caído para un comando degradable, setea AITL_DB_DEGRADED=1 + warning y continúa (en vez de exit). runOnHost (src/hosts/run.ts), en modo degradado, corre el host directo con el prompt crudo y NO persiste (sin run record, hydrate ni prompt history), devolviendo igual output+tokens — mismo contrato que el flujo Delegar interactivo (src/interactive/task.ts). El loop nativo `run` NO se degrada a propósito: persiste cada iteración, degradarlo es cambio aparte y no es el path del experimento (Cara B). (B) hydrate garantiza frescura: se parametriza el tope con opts.limit (default 6, antes 4 fijo) y SIEMPRE se une una pasada de recencia (los N ADRs más nuevos por updated_at), recent-first + dedupe por id, antes de partitionDecisions — un ADR recién grabado se inyecta aunque textSearch rankee otros. Tests nuevos: src/hosts/run.test.ts (degradado) y un caso en src/decisions/lifecycle.test.ts (ADR fresco se inyecta y el conteo supera 4).

## Consequences

- verify 292/292 (antes 290; +2 tests). typecheck limpio. - run-host ya no pierde trabajo ante caídas de Atlas: el agente corre, el gate evalúa código real, y collect-metrics escribe la fila con run_id vacío pero status/gate/dur_s reales. - C2 vuelve a medir H3/H7: los ADRs de fases previas entran al hydrate. - Cambios sin commitear todavía (pendiente: commit en feat/harness-v2 + espejo `aitl sync --project aitl-js`). - Pendiente relacionado: degradar también el loop nativo `run` si se necesita para C1/loop. Experiencia en memoria aitl-js raytracer-metrics-two-harness-bugs-2026-07-07. Plan: thesis-harness/PLAN-REPARACION-HARNESS-METRICAS.md.
