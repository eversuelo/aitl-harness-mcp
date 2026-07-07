# Source Map

Mapa de modulos de `src/` para leer el harness desde GitHub.

| Ruta | Rol |
|---|---|
| [cli.ts](cli.ts) | Superficie CLI `aitl`. |
| [config.ts](config.ts) | Config efectiva: env, perfil global y defaults. |
| [config/store.ts](config/store.ts) | Perfil `~/.aitl/config.json`; ver [ADR-0006](../docs/adr/0006-user-level-config-profile.md). |
| [contracts.ts](contracts.ts) | Tipos/contratos compartidos. |
| [providers/](providers/) | Puerto LLM agnostico multi-provider (ADR-0044): `anthropic` directo (SDK oficial) + `openrouter`/`lmstudio`/`openai-compat` via `OpenAIProvider`, con `FallbackProvider` (`--model auto`). |
| [repl/](repl/) | `aitl chat`: REPL estilo Claude Code sobre el loop (streaming, traza de tools, slash commands). ADR-0003/0044. |
| [orchestration/](orchestration/) | Loop agente, checkpointing y rollup de telemetria por run. |
| [memory/](memory/) | Schemas, store, clasificador, sintetizador (compresión rodante `--compact`, ADR-0059), versionado (`versioning.ts`/`history.ts`). |
| [auth/](auth/) | RBAC + usuarios + auditoria (ADR-0024/0026). |
| [softwares/](softwares/) · [repos/](repos/) · [branches/](branches/) | Jerarquia software→projects→repos + grafo de ramas (ADR-0028/0031). |
| [roles/](roles/) | **Roles de ingenieria (H11)**: schema/store/engine/seed (review/pair/gate). ADR-0033. |
| [specs/](specs/) | **SDD (Pilar 4)**: `classify.ts` (auto-detección de specs ES/EN, sin flags) + `synthesis.ts` (síntesis spec↔tarea con métricas). ADR-0034. |
| [hosts/](hosts/) | HostAdapters (claude-code/codex/antigravity). `claude-code` mide tokens/costo/turnos vía `--output-format json`; permisos SIEMPRE explícitos en el argv (`resolveHostSpec`, ADR-0058); `run.ts` persiste el run, el prompt y la síntesis de specs. ADR-0020/0034/0058. |
| [builder/](builder/) · [indexing/](indexing/) | Constructora de skills/agentes e indexador maestro (ADR-0030). |
| [graph/](graph/) | `graphify` puro + knowledge map multi-entidad (ADR-0025/0029). |
| [db/](db/) | Cliente Mongo e indices. |
| [ingest/](ingest/) | Ingesta de markdown/transcripts y embeddings. |
| [repomap/](repomap/) | Parseo, ranking y cache del mapa de repo (sub-scope `repo`). |
| [decisions/](decisions/) | ADR store y sincronizacion (+ versionado). |
| [tools/](tools/) | Registry y herramientas de filesystem/shell. |
| [hooks/](hooks/) | Gates deterministas. |
| [context/](context/) | Captura/hidratacion de sesion para hosts externos (ADR-0022). |
| [conventions/](conventions/) | Carga de convenciones del proyecto. |
| [adapters/](adapters/) | Export a Cursor, Copilot, Antigravity, Kiro, Trae y AGENTS.md. |
| [mcpserver/](mcpserver/) | Servidor MCP stdio + HTTP. |
| [server/](server/) | API HTTP y launcher de UI web (incluye knowledge map). |
| [interactive/](interactive/) | Panel `aitl -i` + rama «Task» (Planear/Delegar/Council, ADR-0056); ver [ADR-0008](../docs/adr/0008-interactive-control-panel.md). |
| [council/](council/) | Plan-council (ADR-0055): propuestas paralelas, crítica anonimizada con rúbrica, juez independiente; hosts en solo-lectura. |
| [coord/](coord/) | Coordinación mínima multi-agente (ADR-0054): task claims con TTL + eventos durables + polling incremental. |
| [sync/](sync/) | Sync markdown bidireccional Mongo ⇄ `.aitl/` + `docs/adr/` (ADR-0051). |
| [init/](init/) | `aitl init`: onboarding idempotente de un repo (ADR-0052) + guías `agent`/`claude`. |
| [mcpclient/](mcpclient/) | Cliente MCP: monta servidores de `.mcp.json` como tools `mcp__<server>__<tool>` (ADR-0041). |
| [models/](models/) | Modelos Mongoose — única fuente de shape/validación (ADR-0036). |
| [util/](util/) | Helpers sin dominio (`git.ts`, `branches.ts`, `diff.ts`, `retry.ts`, `optional.ts`). |

## Flujos de lectura

### Ejecutar una tarea

1. [cli.ts](cli.ts) resuelve el comando `run`.
2. [providers/base.ts](providers/base.ts) selecciona provider.
3. [orchestration/graph.ts](orchestration/graph.ts) ejecuta el loop.
4. [tools/base.ts](tools/base.ts) despacha tools.
5. [memory/store.ts](memory/store.ts) persiste runs, mensajes y memoria.

### Medir una tarea sobre un host (Cara B)

1. [cli.ts](cli.ts) resuelve `run-host`.
2. [specs/classify.ts](specs/classify.ts) clasifica el prompt (spec vs tarea).
3. [hosts/run.ts](hosts/run.ts) hidrata, ejecuta el host y persiste el run.
4. [hosts/base.ts](hosts/base.ts) parsea el JSON de Claude Code → tokens/costo/turnos.
5. Si es spec, [specs/synthesis.ts](specs/synthesis.ts) escribe la síntesis spec↔tarea.
6. `aitl run-show` / `GET /api/runs` exponen la telemetría (UI: pestaña Runs).

### Ingestar y buscar memoria

1. [ingest/markdown.ts](ingest/markdown.ts) parsea markdown.
2. [memory/classifier.ts](memory/classifier.ts) clasifica.
3. [ingest/embedder.ts](ingest/embedder.ts) genera embeddings.
4. [memory/store.ts](memory/store.ts) escribe y busca.
5. [db/indexes.ts](db/indexes.ts) mantiene indices.

### MCP

1. [mcpserver/server.ts](mcpserver/server.ts) registra tools MCP.
2. Cada tool reusa stores y modulos existentes.
3. `record_prompt`, `list_prompts` y `search_prompts` usan la coleccion durable `prompts`.
4. La salida MCP va por stdio; logs diagnosticos van por stderr o archivo.

### UI de memoria

1. [server/ui.ts](server/ui.ts) arranca API + Vite.
2. [server/api.ts](server/api.ts) proyecta `MemoryStore` como HTTP.
3. [../web/README.md](../web/README.md) cubre el cliente React.
