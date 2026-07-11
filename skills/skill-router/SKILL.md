---
name: skill-router
description: >-
  Enruta cualquier tarea a la skill, rol o agente correcto del proyecto aitl-js.
  Úsala al INICIO de toda tarea no trivial, cuando no sepas qué capacidad cargar,
  cuando el usuario pida "usa el harness", o antes de improvisar un procedimiento
  que probablemente ya exista como skill. Fuente de verdad: colecciones skills/agents
  del MCP aitl-js (search_skills/get_skill), NUNCA copias en contexto.
---

# Skill router — mapa de enrutamiento del harness

Meta-skill: dado el intento de la tarea, decide **qué cargar** y **por qué vía**.
El mapa completo con diagrama vive en `docs/MAPA-SKILLS.md`.

## Tabla de ruteo

| Si la tarea es… | Carga | Vía |
|---|---|---|
| Iniciar trabajo en un repo / contexto stale (repomap de otra rama) | skill `repo-indexer` | `get_skill` + tool `index_repo` / `get_repomap {root}` |
| Crear o actualizar una skill / un agente reutilizable | skill `definition-builder` | `get_skill` + tool `build_definition` |
| Registrar un ADR / dudas de numeración / punteros stale | skill `adr-ledger-reconcile` | `get_skill(project="__global__")` — **explícito**: el router NO auto-enruta `__global__` |
| Cerrar sesión / "guarda lo aprendido" | skill `memoria-sesion` | `get_skill` + checklist de la skill |
| Cambio con riesgo de regresión / "¿dónde afecta?" | `PLAN-REPOMAP-V2.md` (fase F4 `get_impact` aún no implementada) | leer el plan; mientras tanto `get_module_brief <dir>` |
| Revisión de seguridad o secretos | rol `security` (gate, blocking) | `aitl run --roles security` · `aitl role gate-check <path> --role security` |
| Consistencia arquitectónica / no contradecir ADRs | rol `architect` (gate, blocking) | `aitl run --roles architect` · `aitl review <target> --roles architect` |
| Cobertura de pruebas / edge cases | rol `qa` (pair, advisory) | `aitl run --roles qa` (hoy critica al cierre, no por edición) |
| Operabilidad / deploy / rollback | rol `devops` o `devsecops` (review) | `aitl review <target> --roles devops` |
| Implementar en ESTE repo | agent `harness-engineer` | se auto-enruta al preámbulo del loop; o `run_agent` MCP |

## Procedimiento

1. `search_skills { project: "aitl-js", query: "<términos de la tarea>" }` — ¿existe ya una skill?
2. Si el match es claro: `get_skill { project, name }` y **sigue sus instrucciones** (no las parafrasees de memoria).
3. Si toca revisión con criterio: `list_roles { project: "aitl-js" }` y acopla con `--roles` (los roles son opt-in, jamás se auto-seleccionan).
4. Si es un procedimiento global (multi-proyecto): repite la búsqueda con `project: "__global__"`.
5. Si no existe la capacidad: créala con `definition-builder` (upsert por `(project, name)`) y regístrala en `docs/MAPA-SKILLS.md`.

## Límites del router (conócelos antes de confiar en él)

- El loop inyecta **máximo 3 skills** por corrida, presupuesto ~6000 chars (`src/projectctx/router.ts`).
- Solo enruta el **project del run**: las skills `__global__` requieren carga explícita (E6 pendiente, ADR-0038).
- `aitl run-host` (hosts externos) **no** enruta skills/agents/roles — solo hidrata memoria+ADRs+conventions+repomap.
- En `aitl chat` el ruteo corre solo en el **primer turno** de la sesión.

## Guardrails

- No cargues más de lo que la tarea pide: cada skill inyectada consume presupuesto de contexto.
- Si dos skills aplican, prioriza la específica del dominio sobre la meta (esta).
- Mantén la tabla de ruteo sincronizada con la BD: alta/baja de skill ⇒ actualizar `docs/MAPA-SKILLS.md` y esta tabla.
