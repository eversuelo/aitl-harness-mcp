# ADR-0059 — Compresión rodante del knowledge en synthesize (compacted_into, plegado incremental, map-reduce)

- **Status:** accepted
- **Date:** 2026-07-07
- **Components:** src/memory, src/models, src/cli.ts

## Context

`aitl synthesize` resumía pero no comprimía: escribía un doc synthesis por categoría y las fuentes seguían contando para el trigger de crecimiento, seguían apareciendo en el preámbulo de hydrate, cada corrida re-leía TODO el banco, y el camino con LLM truncaba en silencio a 12k chars (violando «no silent caps»). El knowledge del proyecto crece monótonamente (memorias de sesión, hallazgos, notas) y el usuario pidió compresión real. Además, la primera corrida E2E viva expuso que una respuesta vacía del modelo se escribía como síntesis en blanco — con compactación eso destruiría knowledge.

## Decision

La síntesis se vuelve COMPRESIÓN RODANTE con ciclo de vida suave (mismo patrón que ADR-0049 para ADRs: excluir sin borrar). (1) Campo `compacted_into: string|null` en el modelo de memoria: una fuente absorbida apunta al slug de su síntesis; `memoryDocCount`/`memoryTokenEstimate`/`iterMemory` (default) y las tres ramas de `relevant()` (hydrate) miden/devuelven solo la memoria VIVA (`compacted_into: null` casa también docs pre-migración sin el campo); la búsqueda explícita (search_memory, vector/text del MCP) SÍ alcanza compactados — recall profundo intencional. (2) Plegado incremental: cada corrida lee la síntesis previa de la categoría (slug estable `synthesis-<project>-<categoria>`, versionada por upsert) y la pliega junto con SOLO los docs vivos nuevos; categorías frescas exigen ≥2 docs, con síntesis previa basta 1; links = unión de procedencia acumulada. (3) Resumen map-reduce: `chunkTexts` empaqueta fuentes en lotes ≤12k chars (un texto sobredimensionado va entero en su lote), un LLM-call por lote + un reduce final; respuesta vacía del modelo cae al extractivo determinista — una síntesis JAMÁS queda en blanco (guardián anti-pérdida). (4) `markCompacted` en el store (updateMany, metadata de ciclo de vida sin bump de versión); CLI `aitl synthesize --compact` opt-in (sin el flag el comportamiento aditivo previo queda intacto) + reporte de compresión chars antes→después por categoría; el evento `synthesis` lleva las stats (métrica #8 memoria). Synthesizer acepta `embed` inyectable (tests sin descargar el modelo local).

## Consequences

La memoria viva queda acotada de verdad: tras `--compact` el trigger y el preámbulo de hydrate solo pesan la síntesis, no las N fuentes; nada se borra (compactados siguen versionados, espejados por `aitl sync` y buscables). Re-correr synthesize es barato: procesa lo acumulado desde la última corrida, no el banco entero. Sin modelo degrada a extractivo con aviso (F9 intacto). Riesgo aceptado: la calidad de la síntesis modelo-hecha limita lo que se «recuerda» por defecto — mitigado porque las fuentes siguen alcanzables por búsqueda explícita y el guardián anti-blanco impide el caso destructivo. 10 tests nuevos (290 en total); E2E vivo contra Atlas: 3 docs → síntesis → hydrate solo muestra la síntesis → segunda corrida pliega (versión 2, links n0–n3) → limpieza. dist/ reconstruido.
