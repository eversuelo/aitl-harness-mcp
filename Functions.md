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

`RunAgentOpts`: `provider, registry, store, system, maxIters, hydrate, skills, summarize, gates, denyPaths, roles, installDefaultTools, retries, ask, askPolicy, onDelta, onTool, resume, verify`.
(`onTool` — observador de tool calls para UIs de chat: dispara en `start`/`done`/`denied`; ADR-0044.)
`RunAgentResult`: `run_id, final_text, iters, summary_slug?, selected_skills?, gate_denials?, token_usage?, tool_calls?, status?, decision_brief?`.

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

### Clase `Synthesizer` (compresión rodante, ADR-0059)
`synthesize(project, {force?, commitSha?, compact?})` → `SynthesisReport {written, compacted, categories[]}` —
comprime la memoria cuando excede el límite de tamaño/tokens: pliega la síntesis previa de cada
categoría + solo los docs vivos nuevos; resumen map-reduce por lotes (`chunkTexts`, exportada;
nada se trunca en silencio; respuesta vacía del modelo cae al extractivo). Con `compact: true`
las fuentes absorbidas se marcan `compacted_into` y salen de la memoria viva (hydrate + trigger)
sin borrarse — siguen versionadas y buscables (`MemoryStore.markCompacted`).

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
| `getProvider` | `(which?) => Promise<Provider>` | Resuelve el provider de modelo. **Providers crudos (ADR-0044): `anthropic` \| `openrouter` \| `lmstudio` \| `openai-compat`**. `anthropic` usa el SDK oficial (`src/providers/anthropic.ts`: prompt caching, structured outputs, tool blocks nativos); los otros tres los respalda `OpenAIProvider` via `baseURL`. `--model auto` detecta el primero configurado y encadena el resto como fallback. |
| `providerStatus` | `() => ProviderStatus` | Qué backends están configurados, cuál es el activo y la cadena de fallback (respalda `aitl models`). |
| `detectConfiguredProvider` | `() => string \| null` | Primer provider configurado por prioridad (base de `--model auto`). |
| `getProviderWithFallback` | `(onFallback?) => Promise<Provider>` | Cadena "auto": el provider activo primero, luego cada backend configurado como fallback (`FallbackProvider`); con un solo backend devuelve ese provider. |
| `estimateTokens` | `(text) => number` | Estimación ~4 chars/token compartida. |
| `getEmbedder` | `() => Embedder` | Backend de embeddings (local MiniLM-384 por defecto, Voyage opt-in). |
| `embedOne` | `(text) => Promise<number[]>` | Embebe un texto en un vector. |

`Provider` (interfaz): `complete(prompt, opts?)` · `chat(messages, opts?)` · `chatStream?(messages, opts?)` (streaming opcional, ADR-0005) · `countTokens(text)` · `capabilities()`.
`CompleteOpts.jsonSchema` (ADR-0044): constrained decoding opt-in — `response_format: json_schema` en `OpenAIProvider` (grammar en LM Studio) y `output_config.format` en `AnthropicProvider`; lo usa `decomposeTasks` con fallback a texto libre.

### Clase `FallbackProvider`
Encadena N providers: si una llamada falla duro (conexión rechazada, auth, 5xx…), la repite en el siguiente backend configurado. Complementa el `withRetry` del loop (reintento transitorio en el MISMO provider) — esto cambia de BACKEND. En streaming solo hace fallback si el fallo ocurre antes del primer delta.
Keys: `AITL_API_KEY` única clasificada por prefijo (`sk-ant-*` → anthropic, `sk-or-*` → openrouter); las keys explícitas por provider ganan.

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
| `buildServer` | `() => McpServer` | Servidor MCP (stdio/HTTP) con **55 tools** (registro único en `src/mcpserver/server.ts`). Catálogo completo tool-por-tool en la **§14** de este documento. |
| `main` / `mainHttp` | `() => Promise<void>` | Arranque del MCP por stdio / HTTP. |
| `createApiServer` | `() => Server` | API REST `node:http` (proyección de `MemoryStore`) para el web UI. |
| `startUi` | `(opts) => Promise<void>` | Levanta API + Vite dev server (memory-admin UI). |
| `runInteractive` | `() => Promise<void>` | Panel interactivo (supervisor readline de servicios). |
| `writeAgentGuide` | `(opts) => Promise<string>` | Genera un MD de guía de agente (consultar el MCP en cada decisión). |
| `migrateToAtlas` | `(opts) => Promise<MigrateResult[]>` | Migra la base entre clusters vía el driver. |
| `loadCanon` / `renderRules` / `getAdapter` | — | Canon AGENTS.md y adapters cross-tool (cursor/copilot/antigravity/…). |

> **Comparación experimental (tesis):** no hay comando `eval`. Las condiciones se corren
> con `aitl run`: **C0** = `aitl run --bare` (sin hydrate/skills/gates) vs **C2** = default
> (harness completo); los totales medibles salen de `aitl run-show <runId>`.

---

## 12. Comandos del CLI (`aitl <cmd>`)

`interactive` · `check-db` · `init-db` · `ingest [--repo]` · `search` · **`run [--bare] [--verify-cmd] [--roles]`** ·
**`chat [--model auto] [--ask] [--mcp]`** · **`models [--json]`** · **`sdd`** ·
**`run-host [--permission-mode] [--allowed-tools]`** · **`orchestrate`** · **`council --hosts a,b [--judge]`** ·
`run-show <runId>` · `intervene <runId>` · **`synthesize [--force] [--compact] [--at <ref>]`** ·
`repomap [--repo] [--modules]` · `module-brief <dir>` · `index-repo` · `adr-sync` ·
`adr {history,deprecate}` · `memory history` · **`sync [--pull|--push] --project`** · `export` · `mcp` ·
`config {…}` · `ui` · `prompt {add,list,search}` · `coord {claim,release,list,poll}` ·
`user {bootstrap,register,…}` · `hydrate` · `capture-session` ·
**`init [agent|claude]`** (a pelo = onboarding idempotente del repo, ADR-0052) · `migrate-atlas`.

> **Ciclo harness-v2 (ADRs 0046–0059):** `sync` = espejo markdown bidireccional (ADR-0051);
> `coord` = coordinación mínima multi-agente con claims TTL + eventos (ADR-0054); `council` =
> plan-council con crítica anonimizada, rúbrica y juez independiente, hosts en solo-lectura
> (ADR-0055); `run-host` lleva los permisos SIEMPRE explícitos en el argv (ADR-0058);
> `synthesize --compact` = compresión rodante del knowledge (ADR-0059).

> **Chat y providers (ADR-0044):** `aitl chat` = REPL estilo Claude Code sobre el loop
> (`src/repl/chat.ts`): streaming, traza viva de tool calls (hook `onTool`), slash commands
> `/help /models /model /tools /tokens /new /id /ask /exit`; `--project` opcional (default
> `$AITL_PROJECT` o el basename del cwd), `--model` default `auto`. `aitl models` muestra los
> backends configurados, el activo y la cadena de fallback. `aitl sdd` (ADR-0042) corre la
> Fase D: spec → design → descomposición de tareas persistidas como memoria ligada.

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
`hydrate` (desglose memory/decisions/conventions/repomap) · `session_summary` ·
`skills_route` (payload `selected`; `kind:"agent"` cuando rutea agents, ADR-0063) ·
`retry` · `verify` · `error` · `resume` · `spawn` (sub-agente lanzado) ·
**`review`** · **`role_veto`** · **`deliberation`** (objeciones de rol, H11) · **`human_intervention`** (Tabla 4.3 #6) ·
**`stall`** · **`budget`** · **`reflection`** (loop engineering, ADR-0062) ·
**`council_*`** (plan-council, ADR-0055) · eventos de coordinación en `coord_events`
(`claim`/`release`/`expire_reclaim`/`decision`/`task_done`/`note`, ADR-0054).

---

## 14. Tools MCP del servidor `aitl-js` (55)

Registro único: `buildServer()` en `src/mcpserver/server.ts` (las 10 de agents/skills
salen de la plantilla `registerDefinitionTools`). Todas pasan por `runLogged` — logging
estructurado + telemetría en `mcp_tool_calls` + RBAC (`guardTool` sobre `TOOL_RBAC`,
exportada y con canario en `src/mcpserver/rbac.test.ts`) — **excepto las 4 de historial
de versiones**, que van directo a Mongo sin telemetría (hallazgo 2026-07-11). El actor
es `agent:aitl-server` (override `AITL_MCP_ACTOR_ID`/`_ROLE`); toda decisión RBAC se
audita en `audit`. Parámetros: **negrita = requerido**; `=x` es el default.

### Memoria

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `search_memory` | **query**, **project**, collection=`memory`, limit=10 | Búsqueda semántica sobre `memory`/`messages`/`decisions`: Atlas `$vectorSearch` con fallback `$text`. | — |
| `write_memory` | **project**, **slug**, **body**, description, type=`project`, repo, tags | Upsert de UNA memoria estructurada (clasificada + embebida), keyed por `(project, slug)`. Versionado append-only (ADR-0027). | memory:create |
| `ingest_path` | **path**, **project**, repo | Ingesta masiva de un directorio de markdown como memoria. | memory:create |
| `synthesize` | **project**, provider=`auto` (`anthropic`\|`openrouter`\|`lmstudio`\|`openai-compat`\|`extractive`), force=true, compact=false, return_text=true | Compresión rodante de la memoria viva ejecutada por el modelo PROPIO del server (map-reduce; fallback extractivo — jamás en blanco). Devuelve slugs, stats y los cuerpos de síntesis para re-inyección inmediata por el agente llamador (interop multi-harness). | memory:update |

### Contexto MCP y prompts

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `save_mcp_context` | **project**, messages, summary, title, context, metadata, model, run_id, tags | Snapshot completo de contexto de sesión aportado por el cliente. | memory:create |
| `list_mcp_context` | **project**, limit=50, run_id, source, tag | Lista snapshots, recientes primero. | — |
| `search_mcp_context` | **project**, **query**, limit=10 | Búsqueda por texto en los snapshots. | — |
| `record_prompt` | **project**, **prompt**, title, model, run_id, tags, metadata | Persiste un prompt en el historial durable. | prompts:create |
| `list_prompts` | **project**, limit=50, source, tag | Historial de prompts, recientes primero. | — |
| `search_prompts` | **project**, **query**, limit=10 | Búsqueda `$text` con fallback regex. | — |

### Repo map y grafo

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `get_repomap` | **project**, root, repo, maxTokens=1024 | Mapa tree-sitter+PageRank; con `root` lo (re)construye primero (fija el aviso `[repomap] stale`). | — |
| `get_module_map` | **project**, repo | Mapa de módulos de primer nivel (view/back/mixed/infra) desde el mapa cacheado. | — |
| `get_module_brief` | **project**, **dir**, repo | Brief del módulo: bloque + ADRs activas por `components[]` + memorias `component:<dir>`. | — |
| `index_repo` | **project**, **root**, repo, memory, adr | Indexador maestro: repo map + (opcional) ingest de memoria + adr-sync en una pasada. | memory:create |
| `graphify` | project, scope=`all`, fmt=`json` | Proyecta el estado durable como grafo (symbols por `refs`, memoria por `[[wikilinks]]`). | memory:update |

### Decisiones (ADRs)

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `list_decisions` | **project**, limit=50 | Lista ADRs versionadas (orden ascendente por id). | — |
| `record_decision` | **project**, **id**, **title**, **context**, **decision**, consequences, status=`accepted`, components, review_after | Registra una ADR embebida para `$vectorSearch`; `id` next-free leído de la colección (skill `adr-ledger-reconcile`). | decisions:create |
| `deprecate_decision` | **project**, **id**, **reason**, superseded_by, review_after | Depreca sin borrar (bump de versión + snapshot; sale de hydrate, sigue buscable — ADR-0049). | decisions:update |

### Historial de versiones (⚠️ sin `runLogged`: sin telemetría `mcp_tool_calls`)

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `list_decision_versions` | **project**, **id** | Cadena de revisiones de una ADR (viva + archivadas). | — |
| `get_decision_version` | **project**, **id**, **version** | Una versión específica de la ADR. | — |
| `list_memory_versions` | **project**, **slug** | Cadena de revisiones de una memoria. | — |
| `get_memory_version` | **project**, **slug**, **version** | Una versión específica de la memoria. | — |

### Agents y skills (plantilla ×2 + builder)

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `write_agent` / `write_skill` | **project**, **name**, **content**, description, source=`mcp`, tags | Upsert de UNA definición keyed por `(project, name)`. | agents_skills:create |
| `get_agent` / `get_skill` | **project**, **name** | Una definición; `null` si no existe. | — |
| `list_agents` / `list_skills` | **project**, limit=100, tag | Lista, recientes primero. ⚠️ `list_agents` devuelve TAMBIÉN los roles (`metadata.kind="role"`) — filtra si buscas agents puros. | — |
| `search_agents` / `search_skills` | **project**, **query**, limit=10 | Búsqueda `$text` con fallback regex. | — |
| `delete_agent` / `delete_skill` | **project**, **name** | Borra UNA definición; devuelve si existía. | agents_skills:delete |
| `build_definition` | **kind** (`skill`\|`agent`), **project**, **name**, description, content, tags, host, model | Constructora: contenido inline o scaffold editable; upsert. | agents_skills:create |

### Roles de ingeniería (H11)

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `list_roles` | **project** | Roles review/pair/gate del proyecto. | — |
| `write_role` | **project**, **name**, **lens**, mode=`review`, severity=`advisory`, triggers, denyGlobs, skills, description | Upsert de un rol (vive en `agents` con `metadata.kind="role"`). | agents_skills:create |
| `seed_roles` | **project** | Siembra el catálogo default: security, devops, qa, architect, devsecops. | agents_skills:create |

### Catálogo software → projects → repos

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `write_software` | **name**, display_name, description, projects, tags | Upsert del nivel software (raíz de la jerarquía). | softwares:create |
| `get_software` | **name** | Un software; `null` si no existe. | — |
| `list_softwares` | limit=100, tag | Lista, recientes primero. | — |
| `search_softwares` | **query**, limit=10 | Búsqueda por nombre/display/description. | — |
| `delete_software` | **name** | Borra un software. | softwares:delete |
| `write_repo` | **project**, **name**, software, path, branch, remote, description, tags | Upsert de un repo (hoja); `name` es también el sub-scope `repo` de los datos. | repos:create |
| `get_repo` | **project**, **name** | Un repo; `null` si no existe. | — |
| `list_repos` | project, software, tag, limit=100 | Lista por project y/o software. | — |
| `delete_repo` | **project**, **name** | Borra un repo. | repos:delete |

### Branches

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `sync_branches` | **project**, **repo**, **root**, remote | Lee las ramas locales de git, clasifica (kind/environment/base) y las upserta al catálogo. | branches:create |
| `list_branches` | project, repo, kind, limit=200 | Lista del catálogo, recientes primero. | — |
| `delete_branch` | **project**, **repo**, **name** | Borra una rama del catálogo. | branches:delete |

### Coordinación multi-agente (ADR-0054)

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `claim_task` | **project**, **task_key**, scope, ttl_ms | Claim atómico (UNO activo por project+task_key); conflicto ⇒ `{ok:false, heldBy, expiresAt}`; TTL default 30 min, re-claim propio renueva, expirado se toma (`expire_reclaim`). | coordination:create |
| `release_task` | **project**, **task_key**, outcome=`done` | Libera TU claim (solo el dueño); emite evento con el outcome. | coordination:update |
| `poll_events` | **project**, since, limit≤500 | Eventos de coordinación estrictamente > `since`, ascendentes; devuelve `cursor` incremental. | — |
| `publish_event` | **project**, type=`note` (`note`\|`task_done`\|`decision`), task_key, payload | Publica UN evento de coordinación para que los pares que hacen polling lo vean — el lado «pub» del bus. Best-effort: devuelve `{ok:false}` en vez de lanzar. | coordination:create |
| `coord_status` | **project**, events_limit=20, include_history=false | Estado vivo multi-agente: claims ACTIVOS (tarea→dueño→expiración), eventos recientes y actores vistos con sus claims abiertos — «¿quién más trabaja en este codebase y en qué?». | — |

### Loop verificable y supervisión humana

| Tool | Parámetros | Qué hace | RBAC |
|---|---|---|---|
| `run_agent` | **project**, **task**, bare, verify_cmd, loop_spec, max_iters, budget_tokens, budget_ms=600000, stall_threshold, max_verify_rounds, reflect | El loop completo vía MCP (hydrate + skills/agents + gates + terminación verificada); devuelve `run_id`, `stop_reason`, `verified`, totales. ⚠️ No expone `roles` (solo CLI `aitl run --roles`). | memory:create |
| `record_human_intervention` | **project**, **run_id**, **reason**, minutes=0 | Registra una intervención humana en un run (métrica de supervisión, Tabla 4.3 #6). | memory:create |

> Scope reservado **`__global__`**: skills multi-proyecto (p. ej. `adr-ledger-reconcile`)
> se guardan con `project="__global__"` y se cargan EXPLÍCITAMENTE — el router del loop
> no las enruta (E6 pendiente). Mapa operativo: `docs/MAPA-SKILLS.md`.
