---
name: session-2026-06-23-cli-ui-config-interactive
description: "Sesión 2026-06-23 — superficies CLI/TUI de AITL-Harness-JS: config a nivel usuario con export/import, UI web de administración de memorias, y panel interactivo supervisor."
metadata:
  type: project
  date: 2026-06-23
  repo: AITL-Harness-JS
---

# Sesión 2026-06-23 — CLI/UI/config/panel interactivo (AITL-Harness-JS)

Construcción incremental de un harness agnóstico empezando por el CLI. Todo el trabajo
es **aditivo** y **parity-neutral** (TS-only): no cambia `docs/parity-contract.json`,
`chat()`, ni los comandos batch existentes.

## Deliverables implementados y verificados

1. **Config a nivel usuario + export/import** (para `npm i -g`). Decisión: [[ADR-0006]].
   - `src/config/store.ts`: perfil `~/.aitl/config.json` (override `AITL_HOME`), claves
     ENV-style, máscara de secretos, `resolveProfile`.
   - `src/config.ts`: precedencia `process.env > archivo > defaults`; un env **vacío** no
     ensombrece el valor guardado (footgun corregido).
   - CLI: `aitl config {path,show,export,import,set,unset}`. `show`/`export` enmascaran
     secretos por defecto; `--secrets` para transferencia real.

2. **UI web de administración de memorias** (end-to-end, dos procesos). Decisión: [[ADR-0007]].
   - `MemoryStore`: añadidos `getMemory`, `listMemory`, `deleteMemory`, `listProjects`.
   - `src/server/api.ts`: API HTTP sin dependencias (`node:http`), proyección REST de
     `MemoryStore`; las escrituras reusan el camino de `write_memory` (clasificar→embeddear→upsert).
   - `src/server/ui.ts` + comando `aitl ui`: levanta API + Vite dev juntos (Vite hijo,
     proxy `/api`, Ctrl-C apaga ambos).
   - SPA React en `web/` (Vite): buscar/listar/crear/editar/borrar memorias por proyecto.
   - Deps de la SPA (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@types/*`) en
     **devDependencies** para mantener el `npm i -g` ligero.

3. **Panel de control interactivo** `aitl -i` / `aitl interactive`. Decisión: [[ADR-0008]].
   - `src/interactive/menu.ts`: supervisor readline **sin dependencias**; navegación ↑/↓ +
     Enter, atajos 1-9, `:` modo comando, panel de logs ●/○ por servicio.
   - Servicios (`mcp`, `ui`) como procesos hijo re-lanzando el propio CLI (replay de
     `execPath`+`execArgv`, shim `tsx` en dev). Windows: `taskkill /T`.
   - Bare `aitl`, `aitl -i`, `aitl interactive` abren el panel; guard de no-TTY.

## Decisiones de la sesión (ADRs)
- [[ADR-0003]] TUI "live agent chat" como superficie de primera clase (foco elegido).
- [[ADR-0004]] Ink reservado para el agent-chat TUI.
- [[ADR-0005]] Streaming en el ProviderPort antes del TUI (+ observador del loop).
- [[ADR-0006]] Perfil de config a nivel usuario con export/import.
- [[ADR-0007]] UI web de memorias sobre proyección HTTP de `MemoryStore`.
- [[ADR-0008]] Panel interactivo readish sin dependencias.

## Plan / tareas pendientes
- Fase A/B del plan TUI (`docs/TUI-IMPLEMENTATION-PLAN.md`): streaming en providers +
  observador del loop → dos briefs independientes para Codex (`docs/codex-task-A-*`, `-B-*`).
- Fase C: agent-chat TUI con Ink. Fase D: pulido.
- Opcional: modo `aitl ui` con SPA compilada en un solo puerto para `npm i -g`.

## Estado
`npx tsc --noEmit` verde. `aitl config`, `aitl ui` (API) y el guard del panel verificados
en vivo. La navegación con flechas del panel requiere TTY (no testeable en CI/sandbox).

## Entorno
Mongo en `mongodb://localhost:27018`, DB `aitl`, embeddings locales
(`Xenova/all-MiniLM-L6-v2`, 384 dims). MCP servers definidos en
`thesis-harness/.mcp.json`: `aitl` (Python) y `aitl-js` (TS, `dist/src/mcpserver/server.js`).
