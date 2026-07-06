---
name: cli-extended-help-examples
description: >-
  El CLI tiene --help extensivo por comando: mapa central HELP_EXAMPLES + walker
  recursivo addHelpText en src/cli.ts (cubre todos los comandos y subcomandos).
type: project
category: decision
tags:
  - cli
  - help
  - dx
  - docs
  - 'component:src/cli.ts'
version: 1
updated_at: 2026-06-29T17:05:33.376Z
branch: master
---
`aitl <cmd> --help` ahora muestra Examples/Notes por comando. Implementación en src/cli.ts (antes de program.parseAsync):

- `HELP_EXAMPLES: Record<string,string>` keyed por la RUTA del comando con espacios y SIN prefijo `aitl` (p. ej. "run", "run-host", "config set", "init claude", "build skill", "adr history"). Padres (config/prompt/role/build/init/software/repo/branch/user/adr/memory) llevan un overview con "Subcommands: …".
- `attachHelpExamples(cmd, prefix)` recorre el árbol (cmd.commands) y hace cmd.addHelpText("after", texto) si hay entrada; se invoca con `for (const c of program.commands) attachHelpExamples(c, "")`.

PARA AÑADIR/EDITAR ejemplos de un comando nuevo: agrega una entrada al mapa con su ruta como key (el walker la cablea solo). Es puramente aditivo: no cambia descripciones ni comportamiento. `--help` no dispara el preAction (no conecta a Mongo).

Verificado: typecheck+build verdes, 46/46 tests; salida confirmada para run-host (top-level), init claude (anidado) y config (padre).
