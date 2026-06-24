# Source Map

Mapa de modulos de `src/` para leer el harness desde GitHub.

| Ruta | Rol |
|---|---|
| [cli.ts](cli.ts) | Superficie CLI `aitl`. |
| [config.ts](config.ts) | Config efectiva: env, perfil global y defaults. |
| [config/store.ts](config/store.ts) | Perfil `~/.aitl/config.json`; ver [ADR-0006](../docs/adr/0006-user-level-config-profile.md). |
| [contracts.ts](contracts.ts) | Tipos/contratos compartidos. |
| [providers/](providers/) | Puerto LLM agnostico: Gemini, OpenAI, Anthropic. |
| [orchestration/](orchestration/) | Loop agente y checkpointing. |
| [memory/](memory/) | Schemas, store, clasificador y sintetizador de memoria. |
| [db/](db/) | Cliente Mongo e indices. |
| [ingest/](ingest/) | Ingesta de markdown/transcripts y embeddings. |
| [repomap/](repomap/) | Parseo, ranking y cache del mapa de repo. |
| [decisions/](decisions/) | ADR store y sincronizacion. |
| [tools/](tools/) | Registry y herramientas de filesystem/shell. |
| [hooks/](hooks/) | Gates deterministas. |
| [conventions/](conventions/) | Carga de convenciones del proyecto. |
| [adapters/](adapters/) | Export a Cursor, Copilot, Antigravity, Kiro, Trae y AGENTS.md. |
| [mcpserver/](mcpserver/) | Servidor MCP stdio. |
| [server/](server/) | API HTTP y launcher de UI web. |
| [interactive/](interactive/) | Panel `aitl -i`; ver [ADR-0008](../docs/adr/0008-interactive-control-panel.md). |
| [eval/](eval/) | Runner de evaluacion. |
| [util/](util/) | Helpers sin dominio. |

## Flujos de lectura

### Ejecutar una tarea

1. [cli.ts](cli.ts) resuelve el comando `run`.
2. [providers/base.ts](providers/base.ts) selecciona provider.
3. [orchestration/graph.ts](orchestration/graph.ts) ejecuta el loop.
4. [tools/base.ts](tools/base.ts) despacha tools.
5. [memory/store.ts](memory/store.ts) persiste runs, mensajes y memoria.

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
