# ADR-0062 — Loop engineering: verificación de avance propio + LoopSpec versionada

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/orchestration, src/models, src/cli.ts

## Context

La tesis define loop engineering como el diseño del ciclo iterativo que "verifica su propio avance". runAgent (graph.ts) ya tenía terminación por verificación (opts.verify, ADR-0032/0040), pero con cuatro huecos medibles: (1) verify solo corría cuando el modelo se detenía — agotar maxIters marcaba el run status=done, indistinguible de un éxito verificado; (2) nada detectaba estancamiento (mismas tool calls + workspace sin cambios repetidos N iteraciones); (3) el único presupuesto era maxIters (sin tope de tokens ni wall-clock); (4) la política del loop no era una especificación versionada — harness_config solo guardaba max_iters, así que una medición de C2 no podía afirmar bajo qué diseño de bucle corrió.

## Decision

Seis piezas, todas en src/orchestration/ (sin framework externo): (a) verify también corre al agotar la ventana de iteraciones; el run gana stop_reason (completed | max_iters | verify_exhausted | stalled | budget) y verified, persistidos en el run doc — un run agotado jamás se ve como éxito. (b) Detector de estancamiento (stall.ts): firma de progreso = sha256(tool calls del turno + digest git del workspace); threshold consecutivo (default 3) → primer strike inyecta feedback correctivo, segundo termina el run stalled; StallTracker puro y testeable. (c) Presupuestos duros budgets {tokens, ms} chequeados por iteración; al rozarse, un último turno SIN tools de "cierra y resume el estado" (evento budget) en vez de corte seco. (d) Verificación componible: verifiers[] nombrados — todos deben pasar; fallos agregados en un solo turno de feedback; cada veredicto es su propio evento verify; maxVerifyRounds (default 3) acota las rondas y cada ronda concedida refresca la ventana maxIters (los reintentos de verificación no compiten con iteraciones de trabajo). (e) reflect opcional: tras un verify fallido, un turno de diagnóstico sin tools antes de volver a actuar (evento reflection). (f) LoopSpec versionada (loopspec.ts): zod estricto {maxIters, budgets, stallThreshold, maxVerifyRounds, reflect, verifyCmd}; carga desde archivo JSON o colección loops (DefinitionKind "loop" nuevo); versión = sha256(spec)[:12]; precedencia opts explícitos > spec > defaults; la política resuelta + loop_spec@version se estampan en harness_config. CLI: aitl run --loop-spec/--max-iters/--budget-tokens/--budget-ms/--stall-threshold/--max-verify-rounds/--reflect; el resumen imprime stop_reason y verified. Eventos nuevos stall/budget/reflection en event.model.ts.

## Consequences

- El bucle verifica su propio avance (frase literal de la tesis), no solo su término: estancamiento, agotamiento y presupuesto son desenlaces distintos y medibles (métricas nuevas de estabilidad/eficiencia: stall_strikes, verify_rounds, stop_reason por condición).
- Trazabilidad del loop mismo: cada run declara bajo qué diseño de bucle corrió (loop_spec@version por content-hash).
- Terminación garantizada: iteraciones totales ≤ maxIters × (1 + maxVerifyRounds), acotadas además por budgets.
- Compat: opts.verify sigue funcionando (se envuelve como verifier); status del run sigue done|error — los desenlaces viven en stop_reason (no se rompe run-show/UI).
- 25 tests unitarios nuevos sobre las piezas puras (stall, loopspec, budget); el loop integrado no tiene test E2E sin Mongo (igual que antes).
