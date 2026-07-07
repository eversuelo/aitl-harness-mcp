---
name: cycle-0026-0030-summary
description: >-
  Resumen del ciclo 0026-0030 (2026-06-28): fallback de bootstrap,
  versionamiento, jerarquía software/projects/repos, knowledge map y skills
  meta.
type: project
category: reference
tags:
  - ciclo-0026-0030
  - session-2026-06-28
  - summary
  - 'component:src/auth'
  - 'component:src/memory'
  - 'component:src/graph'
  - 'component:src/builder'
  - 'component:src/indexing'
version: 1
updated_at: 2026-06-28T14:48:30.225Z
---
Ciclo entregado el 2026-06-28 (Opus 4.8), todo verificado contra Atlas (typecheck/build limpios, 33 tests).

ADR-0026 — Auto-bootstrap de root local: bootstrapBaseUser nunca throwea; si users vacía y no hay seed válido genera root local (password aleatorio >=12, mostrado 1 vez). Flag AITL_BOOTSTRAP_AUTOGEN (default true). seedIsValid() no-throw. src/auth/users.ts, config.

ADR-0027 — Versionamiento append-only de ADRs y memoria: colecciones decisions_history/memory_history; campo version + actor_id/actor_role + branch en docs vivos. Helper src/memory/versioning.ts (contentChanged, archiveAndBumpVersion: snapshotea el previo atribuido a SU autor antes del overwrite). Tools MCP list/get _decision/_memory_versions; CLI aitl adr history / aitl memory history --diff (diff por campo + LCS de líneas en src/util/diff.ts); loader src/memory/history.ts.

ADR-0028 — Jerarquía software -> projects -> repos: colecciones softwares (clave name) y repos (clave project,name) con stores/tools MCP/CLI (aitl software|repo {add,list,get,rm}) y recursos RBAC. Sub-scope repo (nullable) en memory/symbols/mcp_context con índices {project,repo}; repomap taggea por repo y deleteMany scoped; hilado en ingest/repomap/hydrate/capture y get_repomap. API GET /api/context, /api/softwares, /api/repos. project sigue siendo la clave de scope.

ADR-0029 — Knowledge map multi-entidad: graphify extendido ADITIVO (graphify y tab Graph intactos). NodeKind +decision/context/software/project/repo; EdgeKind +contains/references. src/graph/knowledge.ts (buildKnowledgeGraph) + knowledgeGraphify; GraphSource +decisions/context/softwares/repos. API GET /api/knowledge-graph?project=&entities=. Web: pestaña Knowledge Map con filtros por tipo, colores por kind, panel de detalle.

ADR-0030 — Skill constructora + indexador maestro + hook: src/builder/buildDefinition.ts (construye/persiste skill o agente, scaffold si falta content) → CLI aitl build skill|agent y MCP build_definition. src/indexing/indexRepo.ts (repomap + ingest + adr-sync en una pasada) → CLI aitl index-repo y MCP index_repo. Seed src/builder/seed.ts registra skills maestras definition-builder y repo-indexer (aitl build seed). Hook SessionStart propuesto en .claude/settings.local.json (corre 'aitl build seed') — BLOQUEADO por el clasificador de auto-mode (self-modification), queda como paso manual pendiente de aprobación del usuario.

Pendientes: (1) aprobar/añadir el hook SessionStart manualmente; (2) los .md de ADR 0026-0030 están en docs/adr/ pero el repomap del backend aún apunta a rutas Windows (re-ingestar desde Linux con aitl index-repo).
