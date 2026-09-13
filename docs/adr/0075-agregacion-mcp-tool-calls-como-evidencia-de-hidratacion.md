# ADR-0075 — Agregación mcp_tool_calls como evidencia de hidratación (ToolCalls: CLI + API + tab web)

- **Status:** accepted
- **Date:** 2026-07-12
- **Components:** src/toolcalls, src/server/api.ts, src/models/mcpToolCall.model.ts, scripts/toolCallsReport.ts, web/src/components/ToolCallsView.tsx

## Context

La colección `mcp_tool_calls` (persistida por `runLogged` en src/mcpserver/server.ts desde el arranque del server MCP) ya guarda un doc por invocación: {project, tool, ok, args, args_preview, result, result_preview, error, error_message, ms, ts}. No existía ninguna proyección/UI sobre ella: no se podía responder "¿qué tools MCP se llamaron, para qué proyecto, y qué contenido concreto trajeron de vuelta (hidrataron) o crearon/mutaron?". El disparador fue querer DEMOSTRAR (para la tesis) que la hidratación de contexto vía MCP realmente ocurre y con qué contenido, no solo contar invocaciones a ciegas.

## Decision

Se agregó una agregación única, compartida por tres superficies:
1) `src/toolcalls/report.ts` (nuevo módulo puro): `summaryByTool(match)` agrupa por {project, tool} (calls, ok, failed, avgMs, first/lastTs) y `topTargets(match)` agrupa además por un `target` derivado de `args` (primer campo no vacío entre slug/name/path/dir/id/query/root, vía $let+$filter+$first en Mongo). Ambas funciones ordenan por `ts` antes del `$group` para que `$last` capture, de forma determinista, el doc más reciente del grupo, y exponen `lastArgsPreview`/`lastResultPreview` (solo si `ok`)/`lastErrorMessage` como evidencia cruda (recortada a 800 chars con `clip()`) de qué se pidió y qué volvió realmente. `kind(tool)` clasifica read vs write reutilizando `TOOL_RBAC` (server.ts): cualquier tool con entrada RBAC muta estado durable, el resto es lectura/hidratación.
2) CLI `scripts/toolCallsReport.ts` (`npm run tool-calls-report -- --project <p> [--since 24h|7d|Nd|ISO] [--json]`): imprime el resumen por tool con la evidencia en una línea.
3) API `GET /api/tool-calls?project=&since=` (src/server/api.ts, sin RBAC extra — mismo criterio que `/api/runs`: lectura, requiere sesión autenticada) + pestaña web nueva "ToolCalls" (`web/src/components/ToolCallsView.tsx`, ícono Wrench, TwoPane propio): lista de tools con badge read/write, y panel de detalle con bloques `<pre>` mostrando args pedidos, evidencia de hidratación (result_preview) y, por target, su propio snippet. Se refresca al cambiar de proyecto/ventana `since` o al pulsar refrescar — no hay polling: los docs de `mcp_tool_calls` solo existen después de que la llamada ya terminó, así que un feed "en vivo" no mostraría nada nuevo entre refrescos manuales.

No se persiste todavía identidad de actor por-llamada en `mcp_tool_calls` (el server MCP opera con una identidad de servicio única `mcpActor()`, no per-sesión) — queda fuera de este ADR; lo que se resolvió aquí es el "qué" y "qué trajo", no el "quién".

## Consequences

Ahora es auditable con evidencia real (no solo conteos) que las tools MCP hidratan contenido: se probó en vivo contra el proyecto `ray-tracer-learning` y se ve, por ejemplo, el cuerpo real de memorias/specs/decisiones devuelto por get_memory/search_memory/list_decisions. La UI y el CLI comparten exactamente la misma agregación (src/toolcalls/report.ts), así que no hay dos fuentes de verdad. Deuda: la clasificación read/write en el frontend (WRITE_TOOLS en ToolCallsView.tsx) es una copia estática de TOOL_RBAC — si TOOL_RBAC cambia hay que sincronizar esa lista a mano (no se expuso vía API para no acoplar el bundle del cliente a server.ts). "Quién" hizo cada llamada (identidad per-sesión/run, no solo el actor de servicio) queda como trabajo futuro si se necesita para la tesis.
