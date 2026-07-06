# ADR-0017 — Repo map operativo vía extractor heurístico (fallback de tree-sitter)

- **Status:** accepted
- **Date:** 2026-06-24

## Context

H3 cableó el repo map en la hidratación, pero el parser (src/repomap/parser.ts) era un stub: degradaba a FileSymbols vacío salvo que existieran los .wasm de tree-sitter (un 'phase 2 TODO'), que no están en este entorno. Resultado: RepoMap.build producía 0 símbolos y la sección de repo map nunca tenía datos reales.

## Decision

Añadir parseFileHeuristic: un extractor por regex keyword-based que se usa cuando loadLanguage devuelve null (tree-sitter no disponible). Extrae definiciones (function/class/interface/type/enum/const-arrow de TS/JS, más def/func/fn de python/go/rust) y todas las referencias de identificadores (menos keywords JS), tras quitar comentarios. El ranker PageRank solo conserva refs que casan con definiciones en otros archivos, así que sobre-coleccionar refs es inocuo. tree-sitter sigue siendo el camino preferente cuando hay .wasm (AITL_GRAMMAR_DIR). Se construyó el repo map real del proyecto aitl-js contra src/ (230 símbolos).

## Consequences

El repo map funciona offline y la hidratación (H3) ahora inyecta símbolos reales rankeados por importancia. Verificado: RepoMap.build('src','aitl-js') → 230 símbolos persistidos; render muestra símbolos top por archivo (getDb, embedOne, runAgent…); hydrate('aitl-js') → repomap:1 con datos reales; typecheck+build limpios. Limitación menor: build almacena rutas absolutas (mejorable a relativas). Desbloquea el uso del repo map por sub-agentes en Fase C.
