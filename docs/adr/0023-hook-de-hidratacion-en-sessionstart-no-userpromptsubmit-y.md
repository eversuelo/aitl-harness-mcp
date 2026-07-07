# ADR-0023 — Hook de hidratación en SessionStart (no UserPromptSubmit) y rutas POSIX para ejecutables en hooks

- **Status:** accepted
- **Date:** 2026-06-25

## Context

Los hooks de Claude Code en Windows se ejecutan vía /usr/bin/bash. (1) El comando del hook usaba la ruta del ejecutable con barras invertidas (C:\\nvm4w\\nodejs\\node.exe) sin comillas; bash interpreta cada \\ como escape y colapsa la ruta a 'C:nvm4wnodejsnode.exe' → command not found, por lo que el Stop hook (capture-session) fallaba silenciosamente (non-blocking). (2) El hook de inyección estaba cableado a UserPromptSubmit, lo que abre una conexión a Atlas y ejecuta aitl hydrate en CADA prompt, añadiendo latencia por turno. ADR-0022 introdujo estos dos hooks (hydrate / capture-session).

## Decision

(1) En las rutas de comandos de hooks usar barras normales '/' para el ejecutable (C:/nvm4w/nodejs/node.exe); Windows las acepta y bash no las consume. La ruta del .js puede ir entre comillas dobles (bash preserva los backslashes dentro de comillas), pero se normaliza a '/' por consistencia. (2) Mover el hook de inyección de UserPromptSubmit a SessionStart: el preámbulo durable (memoria + ADRs + conventions + repo map) se inyecta una sola vez al arrancar la sesión. El hook Stop (capture-session) se mantiene igual. Verificado: C:/nvm4w/nodejs/node.exe --version resuelve bajo bash (v24.16.0).

## Consequences

- El Stop hook (capture-session) ya no falla por ruta malformada.
- Latencia cero de Atlas por turno: la inyección ocurre una vez por sesión, no por prompt.
- Trade-off: SessionStart no recibe prompt, así que aitl hydrate cae a ranking por recencia en vez de relevancia prompt-aware. Aceptable para un preámbulo de arranque.
- Los hooks se cargan al arrancar: requiere reiniciar la sesión de Claude Code para que el cambio de evento tome efecto.
- Regla general para hosts Windows: nunca usar '\\' sin comillas en rutas de ejecutables dentro de comandos de hook.
