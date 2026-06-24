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

## Ampliación (misma sesión)

4. **Cierre del panel interactivo** — `SIGINT/SIGTERM/SIGHUP/SIGBREAK` + backstop `exit`
   matan los servidores hijo **síncronamente** (`spawnSync taskkill /T` en Windows) antes
   de salir, así cerrar la terminal no deja procesos huérfanos. (`src/interactive/menu.ts`).
5. **Rediseño del web UI con shadcn/ui + TailwindCSS** — `web/` con Tailwind v3, alias `@/`,
   tema dark, componentes `ui/{button,input,textarea,label,badge,card,select,separator}`,
   `App.tsx` de dos paneles. `vite build` verde (1658 módulos). Deps en devDependencies.
6. **Historial de prompts en aitl-js** — colección propia `prompts` (fuera de `COLLECTIONS`,
   paridad intacta). MCP tools `record_prompt`/`list_prompts`/`search_prompts` (ya en
   `server.ts`) + `PromptStore` (`src/prompts/`) + CLI `aitl prompt {add,list,search}`,
   compartiendo el mismo esquema/colección.
7. **`aitl init agent [--interactive]`** — genera `AGENTS.md` (contrato operativo) que obliga
   a consultar el MCP `aitl-js` (`search_memory`, `list_decisions`) **antes** de cada
   decisión y a persistir (`record_decision`, `write_memory`, prompt history) **después**.
   (`src/init/agent.ts`).
8. **Preferencia del usuario:** *guardar siempre las memorias/decisiones de cada sesión* en
   el backend `aitl-js`.

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
