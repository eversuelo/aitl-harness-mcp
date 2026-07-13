# ADR-0068 — run-host --no-hydrate: baseline C0 sin contaminación del store

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/cli.ts, src/hosts/run.ts

## Context

La medición del curso raytracer (celda c0-bare@haiku, 2026-07-09) destapó que runOnHost hidrata SIEMPRE el prompt con memoria/ADRs del proyecto (hydrate default true, reforzado por ADR-0060 que inyecta ADRs frescos). Para la condición experimental C0 ("sin harness") eso contamina el baseline: el preámbulo llegó a incluir la solución de la fase 2 (g_pointLight, ADR-0005 del raytracer) sintetizada en campañas previas, y el contexto contradictorio (memoria decía fase-02 hecha, git fase-00, tarea fase-01) hizo que haiku respondiera un saludo sin trabajar (1 turno, 0 tools, gate rojo). RunOnHostOpts.hydrate ya existía pero el CLI no lo exponía. Diagnóstico verificado con host falso (AITL_HOST_CMD_CLAUDE_CODE=cat): el prompt viaja íntegro por stdin; la contaminación era del preámbulo, no una pérdida de stdin.

## Decision

Exponer `--no-hydrate` en `aitl run-host` (cli.ts pasa hydrate: opts.hydrate a runOnHost; commander lo pone en false con el flag). run-course.sh del laboratorio raytracer pasa `--no-hydrate --no-spec-synthesis` SOLO para c0-bare (fases y resumen): C0 ni lee ni escribe el store de conocimiento; c2-memory conserva la hidratación porque ES la condición. Las corridas contaminadas quedan anotadas con `aitl intervene` y en la columna notas del CSV (regla de validez 4: se anotan, nunca se borran).

## Consequences

C0 vuelve a ser un baseline limpio y comparable; las celdas c0 previas a este fix (campaña sonnet 2026-07-07 incluida) deben leerse sabiendo que pudieron hidratar contexto si el store ya tenía contenido. La distinción C0/C2 ahora viaja explícita en el argv del run, no depende del estado del store.
