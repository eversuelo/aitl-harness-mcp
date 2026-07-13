---
name: siembra-skill-router-2026-07-11
description: >-
  Sesión de siembra 2026-07-11 (ADR-0069): qué skills/roles/agents quedaron
  cargados en la BD y en disco, AGENTS.md regenerado, docs/MAPA-SKILLS.md,
  Functions.md §14 con las 52 tools MCP, y jerarquía software→repo creada.
type: project
category: decision
tags:
  - session-2026-07-11
  - siembra
  - skills
  - agents
  - roles
  - adr-0069
  - 'component:skills'
  - 'component:docs'
  - 'component:src/mcpserver'
version: 1
updated_at: 2026-07-11T23:34:04.879Z
branch: feat/harness-v2
commit_sha: 7bca160c7f6be4112677a147c745169bec547b14
---
SIEMBRA DEL REGISTRO (2026-07-11, ADR-0069). Hallazgos que la motivaron en [[verificacion-inyeccion-gates-2026-07-11]]; plan derivado en [[plan-repomap-v2]].

== QUÉ QUEDÓ CARGADO/SEMBRADO ==
- SKILLS (colección skills, project aitl-js): skill-router (NUEVA, meta: tabla de enrutamiento tarea→skill/rol/agente + límites del router), memoria-sesion (NUEVA, checklist de cierre: una memoria por hallazgo + ADR next-free verificado + record_prompt + sync --pull + verificación de recall), repo-indexer y definition-builder (preexistentes, builder). GLOBAL: adr-ledger-reconcile (project __global__, preexistente) — NO se auto-enruta, cargar explícito.
- Espejos en disco formato Claude-Code-nativo: skills/skill-router/SKILL.md y skills/memoria-sesion/SKILL.md (junto al preexistente skills/adr-ledger-reconcile/SKILL.md).
- AGENTS (kind≠role): harness-engineer (NUEVO: brief con consulta MCP previa, TS ESM, npm run verify obligatorio, ADR por decisión, cierre con memoria-sesion).
- ROLES (5, preexistentes ADR-0033, verificados): security (gate/blocking, denyGlobs .env/.pem/id_rsa/secrets), architect (gate/blocking), qa (pair/advisory — OJO: pair hoy = review), devops (review), devsecops (review).
- CONVENTIONS: 8 reglas sembradas desde AGENTS.md §Conventions vía loadConventions (6 error, 2 warn): project key canónico, verify obligatorio, secretos prohibidos, ADR next-free sin pinnear, cierre de sesión con memorias, sync tras escrituras, no duplicar, docs ES / preámbulos EN.
- CATÁLOGO: software aitl-js {projects:[aitl-js]} + repo AITL-Harness-JS (software aitl-js, branch feat/harness-v2) — antes get_software("aitl-js") era null.
- REPOMAP: reconstruido a feat/harness-v2 (estaba stale de feat/mongoose-migration, el warning de ADR-0037 sí saltó).

== DOCS GENERADOS/ACTUALIZADOS ==
AGENTS.md regenerado (contrato + identidad + registro + mapa de inyección de 3 superficies + tabla de gates + §Conventions machine-readable). docs/MAPA-SKILLS.md (diagrama mermaid + tablas skills/roles/agents + superficies + límites + mantenimiento). Functions.md: §14 nueva con las 52 tools MCP (parámetros de schemas reales, RBAC por tool, ⚠️ de las 4 tools de versiones sin telemetría), §13 eventos completado (stall/budget/reflection/council_*/coord), §11 puntero. PLAN-REPOMAP-V2.md (raíz).

== CÓDIGO ==
src/mcpserver/server.ts: TOOL_RBAC +6 entradas y exportada. src/projectctx/router.ts: Math.max(0, presupuesto). Tests nuevos: src/mcpserver/rbac.test.ts + src/projectctx/router.test.ts. Suite 438/438.

== CÓMO SE USA (próxima sesión) ==
Arranque de tarea no trivial: get_skill(aitl-js, "skill-router") → seguir su tabla. Cierre: get_skill(aitl-js, "memoria-sesion") → checklist. El loop auto-enruta máx 3 skills + 3 agents por relevancia; roles solo con aitl run --roles.
