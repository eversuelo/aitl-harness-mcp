# ADR-0063 — Clave de project canónica (.aitl/project.json), run_agent por MCP y routing de agents en el loop

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/projectctx, src/mcpserver, src/orchestration, src/init, src/interactive

## Context

Tres huecos destapados por el uso vivo del 2026-07-08: (1) la trampa del ADR-0055 — comandos sin --project (sync, chat, panel interactivo) caían al basename del cwd (AITL-Harness-JS) o a "default" y veían un scope de Mongo VACÍO en silencio; la trampa estaba documentada pero no resuelta. (2) El bucle agéntico verificable (ADR-0062) solo era invocable por CLI — un cliente MCP (Claude Code) no podía lanzar el loop con quality gates a través del servidor. (3) El loop ruteaba skills al preámbulo pero NO las definiciones de agents del proyecto, así que los briefs operativos no se consultaban en cada run.

## Decision

(a) Resolución canónica del project (src/projectctx/resolveProject.ts): precedencia flag --project > $AITL_PROJECT > .aitl/project.json (búsqueda hacia arriba desde el cwd, así los subdirectorios resuelven a la clave del repo) > basename con AVISO fuerte en stderr. aitl init escribe el marcador .aitl/project.json (paso project-marker idempotente); cableado en sync, chat y el panel interactivo (que antes usaba "default"). (b) Tool MCP run_agent (server.ts, RBAC memory:create): ejecuta runAgent con los mismos parámetros que aitl run — verify_cmd, loop_spec, max_iters, budget_tokens/ms, stall_threshold, max_verify_rounds, reflect, bare — y devuelve run_id, stop_reason, verified, rondas/strikes y totales; budget_ms default 600000 para que una corrida colgada no bloquee la llamada MCP indefinidamente. (c) routeSkills generalizado (opts heading/instruction/filter) y el loop rutea también agents (DefinitionStore("agent")) al preámbulo en el arranque de sesión, excluyendo records con metadata.kind="role" (esos entran por opts.roles); trazado como evento skills_route con kind:"agent". Además: DATABASE_URI muerta removida de .env y .mcp.json; README de guía de uso en español en la raíz del workspace de tesis.

## Consequences

- La trampa del scope vacío queda cerrada por diseño (marcador durable + aviso), no por disciplina de tipeo; el panel interactivo deja de operar sobre "default" sin querer.
- El bucle verificable es invocable desde cualquier cliente MCP: Claude Code puede delegar una tarea con quality gate y recibir stop_reason/verified — el harness completo (C2) disponible vía MCP.
- Cada run consulta memoria + ADRs + skills + agents en hydrate, con trazabilidad por evento; los agents dejan de ser solo exportables (AGENTS.md) y pasan a ser contexto vivo del loop.
- 7 tests nuevos de resolveProject (385 total); typecheck/build limpios; verificación viva de la resolución desde subdirectorio.
- Riesgo aceptado: run_agent es síncrono — corridas largas dependen del presupuesto wall-clock; un modo async (start/poll) queda como trabajo futuro.
