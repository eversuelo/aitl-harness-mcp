---
name: definition-builder
description: Construye y persiste skills/agentes (constructora).
tags:
  - master
  - builder
  - meta
metadata:
  built_by: build_definition
updated_at: 2026-07-01T13:14:58.046Z
---
# Skill: definition-builder (constructora)

> Construye y persiste definiciones de skill o agente en el harness.

## When to use
- Cuando necesites crear o actualizar un skill o un agente reutilizable.

## How
- CLI: `aitl build skill <name> --project <p> [--desc ...] [--content ... | --from <file>] [--tags a,b]`
- CLI: `aitl build agent <name> --project <p> [--host model|claude-code|codex] [--model <id>]`
- MCP: `build_definition { kind: 'skill'|'agent', project, name, description?, content?, tags?, host?, model? }`
- Si omites `content`, se genera un scaffold markdown editable; re-ejecutar con el mismo name lo actualiza (upsert).

## Output
- Un DefinitionRecord en la colección `skills`/`agents`, keyed por (project, name).
