# ADR-0058 — Permisos explícitos en el argv de los hosts (fin de la dependencia de settings + trust)

- **Status:** accepted
- **Date:** 2026-07-07
- **Components:** src/hosts, src/cli.ts

## Context

Diagnóstico operativo (2026-07-07): al delegar una tarea a Claude Code vía `aitl run-host`, el host se lanzaba headless (`claude -p`) SIN postura de permisos explícita, de modo que el enforcement recaía en los settings del directorio destino y en el flag de confianza (trust) de la carpeta/su padre. En un cwd no confiado, `-p` no puede preguntar y deniega en silencio herramientas básicas (Edit, Bash con make/python3) aunque el `.claude/settings.json` del proyecto tenga las reglas allow correctas — clase entera de fallos difícil de diagnosticar. El único mecanismo existente era `readonlyArgs` (ADR-0055, solo council); no había seam para args arbitrarios (solo `AITL_HOST_CMD_&lt;NAME&gt;` para el comando) y `aitl init` no instala reglas allow (solo hooks).

## Decision

La postura de permisos viaja SIEMPRE explícita en el argv del host; nunca se depende de settings ni trust del directorio destino. En `src/hosts/base.ts`:

1. `CliHostSpec.writeArgs`: postura de escritura por defecto para corridas delegadas normales. claude-code: `["--permission-mode","acceptEdits"]` (delegar una tarea de código implica aceptar sus ediciones; Bash y demás siguen gated salvo pre-aprobación).
2. Resolución pura y testeable `resolveHostSpec(name, opts, env)` con capas en orden: `spec.args` → `writeArgs` (solo no-readonly y solo si nada más fija ya `--permission-mode`) → `AITL_HOST_ARGS_&lt;NAME&gt;` (env, tokenizado respetando comillas — seam genérico para cualquier host) → `opts.extraArgs` → `readonlyArgs` AL FINAL solo en readonly, de modo que el modo solo-lectura del council SIEMPRE gana (invariante ADR-0055 intacto: `-p --output-format json --permission-mode plan` byte a byte).
3. `getHost(name, { readonly?, extraArgs? })`; `RunOnHostOpts.hostArgs` propaga; CLI `aitl run-host` gana `--permission-mode &lt;mode&gt;` y `--allowed-tools &lt;lista&gt;` (sintaxis claude-code; con otros hosts el comando falla con mensaje que apunta a `AITL_HOST_ARGS_&lt;NAME&gt;`). La inserción respeta el marcador `-` final de stdin (codex).

El panel interactivo (rama Task → Delegar) y el council heredan el comportamiento sin cambios de código propios.

## Consequences

- La clase de fallos «host mudo en cwd no confiado» desaparece: el mismo comando funciona en cualquier directorio, con o sin settings instalados.
- Cambio de comportamiento deliberado: las corridas delegadas de claude-code pasan de modo default (denegar todo en headless sin settings) a `acceptEdits`; Bash sigue requiriendo pre-aprobación explícita (`--allowed-tools` o `AITL_HOST_ARGS_*`), y `bypassPermissions` queda como opción consciente del operador para pilotos aislados.
- El contrato readonly del council no se toca (readonlyArgs se aplica al final y los tests E2E lo asertan byte a byte).
- 12 tests nuevos (280 en total): resolución de capas, supresión del default ante `--permission-mode` explícito, tokenización con comillas, inserción ante `-` final, y un E2E que aserta el argv real recibido por un host fake.
- `dist/` reconstruido (npm run build) para que el binario global recoja el cambio.
