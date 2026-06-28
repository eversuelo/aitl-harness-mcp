# ADR-0030 — Skill constructora, indexador maestro de repo y hook de seed

## Status

accepted

## Context

El usuario pidió (1) una **skill constructora** y un **hook** que construya la skill
y/o agente cada que se invoque, y (2) una **skill maestra** que analice todo el repo e
indexe lo necesario para desarrollar. En el harness las skills/agentes son
`DefinitionRecord`s (`DefinitionStore`, colecciones `skills`/`agents`); el indexado
durable son `symbols` (repo map), `memory` y `decisions`.

## Decision

- **Constructora** — `src/builder/buildDefinition.ts` construye y persiste UN skill o
  agente: si falta `content`, genera un scaffold markdown editable; `host`/`model` de
  agentes van a `metadata`; upsert por `(project, name)` vía `DefinitionStore`.
  Expuesto como CLI `aitl build skill|agent <name>`
  (`--desc/--content/--from/--tags/--host/--model`) y MCP `build_definition` (gateado
  en `TOOL_RBAC` bajo `agents_skills.create`).
- **Maestra** — `src/indexing/indexRepo.ts` corre en una pasada best-effort: repo map
  (tree-sitter + PageRank) + ingest de memoria markdown (opcional) + `adr-sync`
  (default `<root>/docs/adr`), reportando cada paso. Expuesto como CLI `aitl index-repo`
  (`--root/--project/--repo/--memory/--adr`) y MCP `index_repo` (gateado bajo
  `memory.create`).
- **Seed** — `src/builder/seed.ts` registra idempotentemente dos skills maestras
  `definition-builder` y `repo-indexer` (descubribles vía `search_skills`); CLI
  `aitl build seed --project`.
- **Hook** — se propuso un hook `SessionStart` en `.claude/settings.local.json` que
  corre `aitl build seed` cada inicio de sesión (idempotente, best-effort con
  `|| true`). El clasificador de auto-mode bloqueó la auto-modificación de settings, así
  que queda como **paso manual** aprobado por el usuario (snippet abajo).

```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command",
      "command": "node /home/eversuelo/Code/thesis-harness/AITL-Harness-JS/dist/src/cli.js build seed --project aitl-js >>/home/eversuelo/Code/thesis-harness/AITL-Harness-JS/logs/seed-hook.log 2>&1 || true" } ] }
  ]
}
```

## Consequences

- Construir skills/agentes es ahora un comando/tool de primera clase con scaffold por
  defecto; re-ejecutar actualiza (upsert).
- El indexador maestro da "todo lo necesario para desarrollar" en un solo paso,
  scopeable por `repo` (ADR-0028) y con `branch` (ADR-0027/0028).
- Las skills maestras quedan auto-documentadas y descubribles.
- El hook de seed requiere aprobación manual por la política de auto-modificación de
  settings.
- Verificado contra Atlas: `build skill/agent` (scaffold), `build seed` (2 skills),
  `index-repo` (346 símbolos, branch `@master`); limpieza ok.
- **Diseño (DSR):** tratar la construcción de definiciones y el indexado como
  capacidades reutilizables (CLI + MCP + skill descubrible) hace el harness
  auto-extensible; el seed idempotente vía hook materializa las capacidades meta sin
  estado manual.
