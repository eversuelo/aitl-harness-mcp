---
name: repo-indexer
description: Indexa todo el repo (symbols + memoria + ADRs) para desarrollar (maestra).
tags:
  - master
  - indexer
  - meta
metadata:
  built_by: build_definition
updated_at: 2026-07-01T13:14:58.047Z
---
# Skill: repo-indexer (maestra)

> Analiza todo el repo e indexa lo necesario para desarrollar: repo map (símbolos),
> memoria markdown y ADRs, en una sola pasada.

## When to use
- Al iniciar trabajo en un repo, o tras cambios grandes, para refrescar el contexto durable.

## How
- CLI: `aitl index-repo --root <dir> --project <p> [--repo <r>] [--memory <dir>] [--adr <dir>]`
- MCP: `index_repo { project, root, repo?, memory?, adr? }`
- Pasos (best-effort, reportados por separado): repomap (tree-sitter + PageRank) → ingest de memoria → adr-sync.

## Output
- Símbolos en `symbols`, memoria en `memory`, ADRs en `decisions` — todo scopeable por `repo`.
