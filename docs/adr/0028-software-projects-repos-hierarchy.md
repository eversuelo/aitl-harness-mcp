# ADR-0028 — Jerarquía software → projects → repos con sub-scope `repo` en la data

## Status

accepted

## Context

El harness scopeaba toda la data por un único string `project` (sin colecciones
`projects`/`softwares`/`repos`). Faltaba una jerarquía de producto: un **software**
(p.ej. Schoolar) compuesto de varios **projects**, y cada project de varios **repos**
(git). Además, la procedencia se beneficiaba de saber en qué repo y en qué rama git se
originó cada artefacto.

## Decision

Dos colecciones de catálogo nuevas:

- `softwares` (clave global `name`; `display_name`, `description`, `projects[]`, `tags`).
- `repos` (clave `(project, name)`; `software`, `remote`, `branch`, `path`, `tags`).

Con stores espejando `DefinitionStore` (upsert/get/list/search/delete), tools MCP
(`write/get/list/search/delete_software` y `*_repo`) gateadas en `TOOL_RBAC` con
recursos nuevos `softwares`/`repos` en la matriz (root allow / admin delegated / agent
allow), y CLI `aitl software {add,list,get,rm}` y `aitl repo {add,list,get,rm}`.

`project` sigue siendo la clave de scope (cero blast-radius en la data). Como sub-scope
de mayor fidelidad se añadió el campo `repo` (nullable) a `MemoryDocSchema`,
`SymbolSchema` y a los snapshots de `mcp_context`, con índices de filtro
`{project, repo}`. `symbols` no tenía índice único (se regenera por
`deleteMany`+`insert`), así que `repomap` ahora taggea symbols por repo y su
`deleteMany` se scopea por `(project, repo)` para no borrar otros repos.

Se hiló `repo` (opcional) por `ingest_path`/`write_memory` (MCP), `aitl ingest --repo`,
`aitl repomap --repo`, `get_repomap`, `RepoMap.build/render`, `hydrate` (filtro de
memoria + repo map) y `capture-session`. Endpoints HTTP nuevos: `GET
/api/context(/:id)`, `/api/softwares`, `/api/repos`.

Como provenance de versionamiento (ADR-0027) se añadió el campo `branch` (rama git, vía
`util/git.currentBranch` best-effort) a los docs vivos de ADR/memoria, a
`HistoryEntry` y a la superficie de history (CLI/MCP).

## Consequences

- Existe una jerarquía consultable `software → projects → repos` sin romper el scoping
  por `project`.
- La data puede atribuirse a un repo (mayor fidelidad de procedencia) de forma
  aditiva: docs sin `repo` siguen válidos (`repo=null` = nivel project).
- Reconstruir el repo map de un repo no afecta a los otros del mismo project.
- Los nuevos recursos RBAC mantienen fail-closed. La rama git queda registrada por
  versión, ligando versionamiento a la jerarquía git.
- Verificado end-to-end contra Atlas: `init-db` crea `softwares`/`repos`; CRUD CLI ok;
  memoria se distingue por repo.
- **Diseño (DSR):** una jerarquía de catálogo (software/repo) por encima del scope
  existente da estructura de producto y procedencia git sin reescribir el contrato de
  datos; el sub-scope `repo` es opcional para que la fidelidad sea incremental.
- Fuera de alcance: unión cross-repo ponderada en `hydrate` (E6 grupos) y mapeo
  automático `remote → project/repo`.
