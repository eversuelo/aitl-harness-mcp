# ADR-0066 — Tool mcp_add: el LLM monta servidores MCP en caliente desde el chat

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/repl, src/mcpclient

## Context

Los servidores MCP solo se montaban al arrancar el chat (.mcp.json) o por el humano con /mcp add. El plumbing ya soporta montaje en vivo: McpManager registra tools en el mismo ToolRegistry y el loop relee registry.schemas() en cada iteración, así que un tool montado a media sesión es invocable al siguiente turno. Faltaba exponerlo al modelo.

## Decision

Tool mcp_add registrada junto a las built-ins del chat REPL (solo chat, no runAgent genérico): args {name, command, args[]}; monta vía mcp.mount() (si no arranca, no se persiste) y persiste en .mcp.json con upsertMcpServer — espejo exacto de /mcp add. requiresApproval=true porque lanza un proceso hijo (sujeto a --ask, ADR-0040).

## Consequences

- El agente puede autoequiparse con tools MCP a media tarea sin reiniciar el chat; disponibles como mcp__<name>__<tool> al turno siguiente.
- Superficie de riesgo equivalente a ShellTool (spawn de comandos); mitigada por requiresApproval + gates. El montaje se persiste en .mcp.json, así que sobrevive a la sesión — el humano lo revierte con /mcp rm.
- Scope deliberado: solo el chat REPL; el loop nativo de aitl run no la expone.
