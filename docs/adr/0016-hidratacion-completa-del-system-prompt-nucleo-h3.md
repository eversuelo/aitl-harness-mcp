# ADR-0016 — Hidratación completa del system prompt (Núcleo H3)

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Núcleo H3 del plan reordenado. hydrate() solo inyectaba memoria (y el router de skills inyectaba skills, ADR 0013), pero el preámbulo de contexto del proyecto estaba incompleto vs. el plan: faltaban repomap (symbols/PageRank), ADRs (decisions) y conventions. El agente arrancaba sin saber decisiones ni reglas ni el mapa del repo.

## Decision

Extender hydrate() (src/memory/lifecycle.ts) para componer TODO el contexto durable relevante: memoria + decisiones + conventions + repomap. Se generalizó la cascada de relevancia a relevant(store, collection, prompt) (vector→texto→recencia) reusando MemoryStore.vectorSearch/textSearch sobre cualquier colección (ADRStore no tenía listado). Cada fuente es best-effort y está acotada por su propio presupuesto de caracteres; renderers dedicados (renderMemory/renderDecisions/renderConventions/renderRepomap). RepoMap se importa de forma perezosa para no cargar el parser tree-sitter en cada hidratación; conventions se leen directo de su colección. HydrateResult ahora trae sections {memory,decisions,conventions,repomap} con toggles opt-out en HydrateOpts. runAgent registra el desglose en el evento 'hydrate'.

## Consequences

El system prompt recupera el contexto completo del proyecto (memoria, decisiones, reglas y mapa del repo), todo con la misma cascada robusta que funciona sin índice vectorial. Verificado end-to-end contra Atlas: sembrando una de cada fuente, hydrate() produce las 4 secciones con sus cabeceras y contenido, sections={memory:1,decisions:1,conventions:1,repomap:1}, y runAgent emite el desglose en el evento hydrate; 0 residuos; typecheck+build limpios. Cierra H3 y el endurecimiento del núcleo. Siguiente: Fase C (orquestador + sub-agentes paralelos).
