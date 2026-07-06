---
name: init-claude-md-generator
description: >-
  aitl init claude: genera un CLAUDE.md inicializador que cablea Claude Code a
  este harness (contrato MCP + medición + setup). + fix del cuelgue en
  subcomandos no-DB.
type: project
category: bug
tags:
  - cli
  - init
  - claude-md
  - onboarding
  - mcp
  - bugfix
  - 'component:src/init'
  - 'component:src/cli.ts'
version: 1
updated_at: 2026-06-29T16:32:02.168Z
branch: master
---
Nuevo comando `aitl init claude` (hermano de `aitl init agent`). Genera un CLAUDE.md inicializador para CUALQUIER repo donde se quiera que Claude Code use este harness.

ARTEFACTO: src/init/claude.ts (renderClaudeMd + writeClaudeGuide) + subcomando en src/cli.ts (init claude --project --mcp --out --force -i). El CLAUDE.md generado incluye: scope de proyecto, contrato "consulta MCP antes / persiste después" (search_memory/list_decisions/get_repomap → record_decision/write_memory/record_prompt), sección "this session is telemetered" (tokens/turnos + grafo por sesión + specs), y checklist de SETUP (registro .mcp.json, permisos mcp__<mcp>, hooks UserPromptSubmit=hydrate / Stop=capture-session, aitl config set MONGODB_URI). NO sobrescribe un CLAUDE.md existente salvo --force (protege el canónico de este repo). Verificado: genera OK a temp, guard rc=1 sobre CLAUDE.md del repo.

BUGFIX (mismo cambio): el hook preAction de cli.ts saltaba la conexión a Mongo solo si actionCommand.name() ∈ NO_DB_COMMANDS, pero para subcomandos anidados (init claude → name="claude", init agent → "agent", config set → "set") eso NO casaba → conectaban a Mongo y el proceso NO salía (colgaba 2 min hasta SIGTERM). Fix: el preAction ahora recorre la cadena de padres (for cmd=actionCommand; cmd; cmd=cmd.parent) y salta si CUALQUIER ancestro está en NO_DB_COMMANDS. Esto también corrige el cuelgue latente de `aitl init agent` y `config *`.

README: comando documentado en "Forzar que Claude Code use siempre el MCP" (capa 3) y en la tabla de comandos. typecheck+build verdes, 46/46 tests.
