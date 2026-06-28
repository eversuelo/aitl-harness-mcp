# Functions.md — Funciones del harness (AITL-Harness-JS)

Catálogo de la superficie funcional del harness: API de librería (exports de `src/index.ts`),
clases clave con sus métodos, comandos del CLI y los tipos de evento que el loop emite.
Las firmas son las reales del código; las descripciones, en español.

> Proyecto canónico (backend aitl-js): `aitl-js`. Ver `CLAUDE.md`.

---

## 1. Núcleo — el loop del agente

| Función | Firma | Qué hace | Pilar |
|---|---|---|---|
| `runAgent` | `(prompt, project, opts?) => Promise<RunAgentResult>` | Loop agnóstico prompt→modelo→tools→repeat, persistido a Mongo. Hidrata contexto al inicio, enforces gates, reintenta fallos transitorios, audita denegaciones, resume sesión, soporta `resume`/`verify`. | A·B·H1·H2·H3 |
| `orchestrate` | `(master, project, opts?) => Promise<OrchestrateResult>` | Orquestador flaco: descompone la tarea (plan o `tasks`), lanza N `runAgent` en paralelo (`ContextManager` fresco c/u) y sintetiza. | C |
| `buildGraph` | `(opts?) => Promise<CompiledGraph>` | Cablea el mismo loop como `StateGraph` de LangGraph con checkpointer Mongo (resumible/replayable). | — |
| `getCheckpointer` | `() => Promise<unknown>` | Checkpointer LangGraph respaldado en Mongo (import perezoso). | — |

`RunAgentOpts`: `provider, registry, store, system, maxIters, hydrate, skills, summarize, gates, denyPaths, installDefaultTools, retries, resume, verify`.
`RunAgentResult`: `run_id, final_text, iters, summary_slug?, selected_skills?, gate_denials?, status?`.

---

## 2. Memoria y ciclo de vida (Pilar 1)

| Función | Firma | Qué hace |
|---|---|---|
| `hydrate` | `(project, prompt, opts?) => Promise<HydrateResult>` | Compone el preámbulo del system prompt con TODO el contexto durable: memoria + ADRs + conventions + repo map (cascada vector→texto→recencia). |
| `summarizeSession` | `(project, runId, convo, opts?) => Promise<SessionSummary \| null>` | Comprime la sesión en UNA memoria durable auto-clasificada y embebida. |
| `TRIGGER_CATEGORIES` | `Set<string>` | Categorías que marcan una sesión como digna de guardar (decision/bug/convention/reference). |

### Clase `MemoryStore` — gateway único a la memoria durable
`upsertMemory(doc)` · `appendMessage(msg)` · `logEvent(event)` · `getMessages(runId)` ·
`vectorSearch(collection, vec, opts)` · `textSearch(collection, query, opts)` ·
`memoryDocCount(project)` · `memoryTokenEstimate(project)` · `iterMemory(project, opts)` ·
`getMemory(project, slug)` · `listMemory(project, opts)` · `deleteMemory(project, slug)` ·
`listProjects()`.

### Clase `Classifier` — taxonomía por proyecto
`classifyText(text, opts?)` · `classifyMemory(doc)` · `classifyMessage(msg)`.

### Clase `Synthesizer`
`synthesize(project, opts?)` — compacta la memoria cuando excede el límite de tamaño/tokens.

---

## 3. Skills y contexto de proyecto (Pilar 3)

| Función | Firma | Qué hace |
|---|---|---|
| `routeSkills` | `(project, prompt, opts?) => Promise<RouteSkillsResult>` | Selecciona skills relevantes (léxico→recencia + re-rank semántico) e inyecta su content en el system prompt. |
| `makeDefinitionRecord` | `(v) => DefinitionRecord` | Constructor del doc compartido de agents/skills. |

### Clase `DefinitionStore` — colecciones `agents` / `skills`
`upsert(rec)` · `get(project, name)` · `list(project, opts?)` · `search(project, query, limit?)` · `delete(project, name)`.
Constantes: `AGENTS_COLLECTION`, `SKILLS_COLLECTION`.

---

## 4. Decisiones, repo map y convenciones (Pilar 2 — hidratación)

| Función | Firma | Qué hace |
|---|---|---|
| `parseAdrMarkdown` | `(path, project) => Promise<ADR>` | Parsea un ADR Nygard (Context/Decision/Consequences) desde markdown. |
| `loadConventions` | `(path, project, opts?) => Promise<Convention[]>` | Carga convenciones desde AGENTS.md (sección `## Conventions`). |
| `parseAgentsMd` | `(path, project) => Promise<Convention[]>` | Parser de reglas de AGENTS.md (severity error/warn). |
| `parseFile` | `(path) => Promise<FileSymbols>` | Extrae defs/refs de un archivo (tree-sitter, o fallback heurístico por regex). |
| `parseTree` | `(root, exts?) => Promise<FileSymbols[]>` | Recorre el árbol de fuentes y parsea cada archivo. |
| `rankSymbols` | `(files) => Map<string, number>` | PageRank sobre el grafo de símbolos (importancia central). |
| `selectWithinBudget` | `(scores, maxTokens?) => [...]` | Elige los símbolos top que caben en un presupuesto de tokens. |

### Clase `ADRStore`
`upsert(adr, opts?)` · `syncDir(directory, project)` — espeja `docs/adr/NNNN-*.md` a Mongo.

### Clase `RepoMap`
`build(root, project)` — parsea, ranquea y persiste símbolos. · `render(project, opts?)` — vista compacta top-N acotada por tokens.

---

## 5. Enforcement y herramientas (Pilar — Núcleo H1)

| Función | Firma | Qué hace |
|---|---|---|
| `installDefaultGates` | `(registry?) => void` | Instala gates de seguridad por defecto (deny `.git/.env/keys`), idempotente por registry. |
| `denyPathsGate` | `(patterns) => PermissionGate` | Gate que deniega escrituras/comandos a rutas que casan con los patrones. |
| `toolSchema` | `(tool) => Record<string,unknown>` | Normaliza el schema de una tool para cualquier provider. |

### Clase `ToolRegistry`
`register(tool)` · `addGate(gate)` · `hasGates()` · `schemas()` · `call(name, args, onDeny?)` — corre gates (audita denegaciones) y captura errores de tool como `[tool error]`.
Singleton: `defaultRegistry`.
Tools built-in: `ReadFileTool`, `WriteFileTool`, `ShellTool`.

### Clase `PhaseGate`
`asGate()` — bloquea un conjunto de tools hasta que una fase se satisface (patrón TDD red→green).

---

## 6. Resiliencia del loop (Núcleo H2)

| Función | Firma | Qué hace |
|---|---|---|
| `withRetry` | `(fn, opts?) => Promise<T>` | Reintenta con backoff exponencial + jitter ante fallos transitorios. |
| `isTransientError` | `(err) => boolean` | Heurística: ¿el error es transitorio (429/5xx/red/timeout)? |

### Clase `ContextManager` — presupuesto de contexto
`overBudget(messages)` · `clearToolResults(messages, keepLast?)` · `compact(messages, keepRecent?)`.

---

## 7. Providers y embeddings (agnosticismo de modelo)

| Función | Firma | Qué hace |
|---|---|---|
| `getProvider` | `(which?) => Promise<Provider>` | Resuelve el provider de modelo. **Unico provider: `openrouter`** (gateway OpenAI-compatible para todos los modelos). `OpenAIProvider` es el cliente generico que lo respalda via `baseURL`. |
| `estimateTokens` | `(text) => number` | Estimación ~4 chars/token compartida. |
| `getEmbedder` | `() => Embedder` | Backend de embeddings (local MiniLM-384 por defecto, Voyage opt-in). |
| `embedOne` | `(text) => Promise<number[]>` | Embebe un texto en un vector. |

`Provider` (interfaz): `complete(prompt, opts?)` · `chat(messages, opts?)` · `countTokens(text)` · `capabilities()`.

### Hosts — el harness corriendo SOBRE otro agente (Cara B)

A diferencia de un `Provider` (modelo crudo que el harness conduce con su loop), un **host** es un
agente completo con su propio loop (Codex, Claude Code, Antigravity). El harness lo **envuelve**:
le inyecta contexto durable y persiste la corrida.

| Función | Firma | Qué hace |
|---|---|---|
| `runOnHost` | `(prompt, project, opts) => Promise<RunOnHostResult>` | Corre una tarea SOBRE un host: hidrata contexto en el prompt, invoca el host, persiste run (role `host`) + transcript + eventos. |
| `getHost` | `(name) => HostAdapter` | Resuelve un host conocido (`claude-code`/`codex`/`antigravity`); comando override por `AITL_HOST_CMD_<NAME>`. |
| `HOST_SPECS` | `Record<string, CliHostSpec>` | Invocaciones headless por defecto de cada host (provisionales, overridables). |

`HostAdapter` (interfaz): `runTask(prompt, opts?) => Promise<HostResult>`. `CliHostAdapter` la
implementa via subproceso (prompt por stdin).

---

## 8. Ingesta

| Función | Firma | Qué hace |
|---|---|---|
| `parseMarkdownFile` | `(path, project) => Promise<MemoryDoc>` | Convierte un .md (con frontmatter/links) en doc de memoria. |
| `parseMarkdownDir` | `(directory, project) => Promise<MemoryDoc[]>` | Ingesta de un directorio de markdown. |
| `extractLinks` | `(body) => string[]` | Extrae `[[wikilinks]]` del cuerpo. |
| `parseJsonl` | `(path, project, runId) => Promise<Message[]>` | Importa un transcript JSONL como mensajes. |
| `parseMarkdownTranscript` / `parseTranscript` | `(path, project, runId) => Promise<Message[]>` | Importa transcripts en markdown / autodetectado. |

---

## 9. Base de datos

| Función | Firma | Qué hace |
|---|---|---|
| `connectWithFallback` | `(opts?) => Promise<...>` | Conecta al `MONGODB_URI` (Atlas seedlist) con fallback a local. |
| `getDb` | `(name?) => Db` · `getClient()` · `closeClient()` | Acceso/cierre del cliente y la base. |
| `checkMongoConnection` | `(name?) => Promise<MongoConnectionReport>` | Diagnóstico de conexión. |
| `redactMongoUri` / `activeUri` | — | URI activa / redactada (sin credenciales). |
| `initIndexes` | `(db?) => Promise<Db>` | Crea colecciones + índices escalares/texto/vectoriales. |
| `ensureCollections` / `ensureScalarIndexes` / `ensureTextIndexes` / `ensureVectorIndexes` | `(db) => Promise<void>` | Sub-pasos idempotentes de `initIndexes`. |
| `COLLECTIONS` | `string[]` | Lista canónica de colecciones (contrato de paridad Py↔TS). |

---

## 10. Configuración (instalación global)

`getSettings()` · `configDir()` · `configFilePath()` · `readConfigFile()` ·
`writeConfigFile(profile, opts?)` · `sanitizeProfile(input)` · `resolveProfile(opts?)` ·
`maskSecret(value)` · `redactUri(uri)` · `settings` (config resuelta).
Precedencia: `process.env` > `~/.aitl/config.json` > defaults.

---

## 11. Superficies y operación

| Función | Firma | Qué hace |
|---|---|---|
| `buildServer` | `() => McpServer` | Servidor MCP (stdio) que sirve memoria/decisiones/skills/agents/prompts a clientes como Claude Code. |
| `main` / `mainHttp` | `() => Promise<void>` | Arranque del MCP por stdio / HTTP. |
| `createApiServer` | `() => Server` | API REST `node:http` (proyección de `MemoryStore`) para el web UI. |
| `startUi` | `(opts) => Promise<void>` | Levanta API + Vite dev server (memory-admin UI). |
| `runInteractive` | `() => Promise<void>` | Panel interactivo (supervisor readline de servicios). |
| `writeAgentGuide` | `(opts) => Promise<string>` | Genera un MD de guía de agente (consultar el MCP en cada decisión). |
| `migrateToAtlas` | `(opts) => Promise<MigrateResult[]>` | Migra la base entre clusters vía el driver. |
| `loadCanon` / `renderRules` / `getAdapter` | — | Canon AGENTS.md y adapters cross-tool (cursor/copilot/antigravity/…). |

### Clase `EvalRunner`
`run(...)` — corre un benchmark (`tasks()` + `verify(task, workdir)`) contra el harness.

---

## 12. Comandos del CLI (`aitl <cmd>`)

`interactive` · `check-db` · `init-db` · `ingest [--repo]` · `search` · **`run [--bare] [--verify-cmd] [--roles]`** ·
**`run-host`** · **`orchestrate`** · `run-show <runId>` · `intervene <runId>` · `synthesize` · `repomap [--repo]` ·
`index-repo` · `adr-sync` · `adr history` · `memory history` · `export` · `eval` · `mcp` ·
`config {…}` · `ui` · `prompt {add,list,search}` · `init agent` · `migrate-atlas`.

**Ciclo 0024–0033 (plataforma + tesis):**
`software {add,list,get,rm}` · `repo {add,list,get,rm}` · `branch {sync,list,rm}` ·
`build {skill,agent,seed}` · **`role {seed,list,rm,gate-check}`** · **`review <target|@file> --roles`**.

> **Roles de ingeniería (H11, ADR-0033):** `role` = persona/lens + modo (`review`/`pair`/`gate`) +
> severidad + binding. Asisten al ingeniero produciendo un **DecisionBrief** (objeciones atribuidas por
> rol), no deciden por él. `gate` veta determinista en el loop (sin modelo); `review`/`pair` critican por
> modelo. `aitl run --roles security,architect` los acopla; `aitl review` delibera sobre un target.

> **Instrumentación del piloto (ADR-0032):** `aitl run-show` expone tokens/iters/tool_calls + `hydrate`
> + intervenciones humanas + roles/decision_blocked; `--bare` = condición C0; `--verify-cmd` = quality
> gate como condición de terminación del loop; `aitl intervene` registra supervisión humana (Tabla 4.3 #6).

---

## 13. Eventos del loop (instrumentación para la tesis)

Emitidos a la colección `events` por `runAgent`/`orchestrate`:

`loop_iter` · `compaction` · `tool_call` · `gate` (denegación auditada) · `synthesis` ·
`hydrate` (desglose memory/decisions/conventions/repomap) · `session_summary` · `skills_route` ·
`retry` · `verify` · `error` · `resume` · `spawn` (sub-agente lanzado) ·
**`review`** · **`role_veto`** · **`deliberation`** (objeciones de rol, H11) · **`human_intervention`** (Tabla 4.3 #6).
