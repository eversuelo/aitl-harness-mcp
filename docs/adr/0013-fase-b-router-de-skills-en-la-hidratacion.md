# ADR-0013 — Fase B — Router de skills en la hidratación de runAgent

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Pilar 3 del plan. Las skills viven en la colección skills (DefinitionStore, [ADR-0011], sin embedding almacenado, búsqueda $text + regex fallback). Faltaba que una sesión seleccionara las skills relevantes al prompt e inyectara sus instrucciones en el system prompt, igual que hydrate ([ADR-0012]) hace con la memoria.

## Decision

Nuevo módulo src/projectctx/router.ts con routeSkills(project, prompt) → { preamble, selected }. Cascada robusta: búsqueda léxica (search) → recencia (list) como pool, y re-ranking semántico opcional best-effort por coseno de embeddings calculados in-process (los records no guardan embedding). Cableado en runAgent: system se compone como [memoria, skills, base] vía array de preámbulos; flag opt-out skills (default true); evento skills_route en el schema y campo selected_skills en RunAgentResult. Reusa la conexión store.db para el DefinitionStore.

## Consequences

Verificado end-to-end contra Atlas con provider mock: la skill relevante se rankea primero por coseno, su content se inyecta bajo '## Project skills', el evento skills_route se emite, el opt-out no inyecta ni emite, limpieza a 0 residuos; typecheck+build limpios. Cierra el pilar de skills. Siguiente: Fase C. (Renumerado desde un 0004 escrito por error bajo AITL-Harness-JS.)
