# Architecture (conceptual overview)

> **Note (English).** This document is the **conceptual, Python-origin architecture
> overview** and predates the current TypeScript data-layer migration. For the up-to-date,
> **canonical TypeScript architecture** — hexagonal ports, the Mongoose data layer
> (`src/models/*.model.ts`), the MCP surface, the CLI and the engineering roles — read
> [ARQUITECTURA-AITL-JS.md](ARQUITECTURA-AITL-JS.md). The sections below remain useful for
> the design intent and the file-level references, but where they mention Zod document
> schemas or the raw MongoDB driver, treat Mongoose as the source of truth (ADR-0036).

---

# Arquitectura de AITL-Harness-JS

> **Qué es.** Un *harness* de agentes **model-agnostic**: orquesta el loop de un agente
> (prompt → modelo → herramientas → repetir), persiste **todo** (transcript, memoria, decisiones,
> eventos de traza) en un único store durable (MongoDB + Atlas Vector Search) y expone ese estado
> por **CLI**, **MCP**, **HTTP/UI** y **adapters cross-tool**.
>
> **Stack.** TypeScript (ESM, Node ≥ 20) · LangGraph (orquestación opcional/resumible) ·
> MongoDB + Atlas Vector Search (store único) · embeddings locales `Xenova/all-MiniLM-L6-v2`
> (384 dims) por defecto, con fallback a Voyage.
>
> Las referencias `archivo.ts:línea` apuntan al símbolo exacto.

---

## 1. Principio rector: puertos y adaptadores (hexagonal)

El **núcleo** (loop, contexto, memoria) depende **solo de puertos** (`contracts.ts`), nunca de un
SDK concreto. Esto es lo que hace al harness agnóstico de modelo, de herramienta y de almacenamiento.

```mermaid
flowchart TB
    subgraph NUCLEO["NÚCLEO (depende solo de puertos)"]
        direction TB
        LOOP["runAgent / orchestrate<br/>orchestration/graph.ts"]
        CTX["ContextManager<br/>context/manager.ts"]
        LIFE["hydrate / summarizeSession<br/>memory/lifecycle.ts"]
    end

    subgraph PORTS["PUERTOS — contracts.ts"]
        direction LR
        PP["ProviderPort<br/>:75"]
        TP["ToolPort<br/>:84"]
        MP["MemoryPort<br/>:92"]
        LS["LoopStrategy<br/>:101"]
    end

    subgraph ADAPTERS["ADAPTADORES (implementaciones concretas)"]
        direction TB
        OAI["OpenAIProvider → openrouter · lmstudio · openai-compat<br/>providers/openai.ts<br/>AnthropicProvider → API directa<br/>providers/anthropic.ts"]
        HOST["HostAdapter: claude-code / codex / antigravity<br/>hosts/base.ts"]
        TOOLS["ReadFile · WriteFile · Shell<br/>tools/*.ts"]
        STORE["MemoryStore → MongoDB<br/>memory/store.ts"]
    end

    LOOP --> PP & TP & MP & LS
    CTX --> PP
    LIFE --> MP
    PP --> OAI
    PP -. "host propio" .-> HOST
    TP --> TOOLS
    MP --> STORE
```

**Puertos (`src/contracts.ts`):**

| Puerto | Línea | Responsabilidad |
|---|---|---|
| `ProviderPort` | `contracts.ts:75` | `chat()`, `complete()`, `countTokens()`, `capabilities()` — cualquier gateway LLM |
| `ToolPort` | `contracts.ts:84` | `run(args) → string` — herramienta invocable con JSON-schema |
| `MemoryPort` | `contracts.ts:92` | `upsertMemory`, `appendMessage`, `logEvent`, `vectorSearch`, `textSearch` |
| `LoopStrategy` | `contracts.ts:101` | `run(prompt, project, opts)` — cómo se conduce una tarea |

> **Invariantes** (ADR-0019/0020, **SUPERSEDED en parte por ADR-0044**): el invariante original
> "un único gateway de modelo = OpenRouter" fue enmendado el 2026-07-02. Hoy `getProvider` resuelve
> **cuatro backends crudos**: `anthropic` (SDK oficial directo, `providers/anthropic.ts`: prompt
> caching, structured outputs, tool blocks nativos) · `openrouter` · `lmstudio` · `openai-compat`
> (estos tres vía el cliente genérico `OpenAIProvider` + `baseURL`, que sigue siendo el único
> cliente OpenAI-compatible — esa parte de ADR-0019 se mantiene). `--model auto` detecta el primer
> backend configurado y encadena el resto como `FallbackProvider`; `AITL_API_KEY` única se
> clasifica por prefijo (`sk-ant-*`/`sk-or-*`). Sigue vigente: los *hosts* externos (Claude Code,
> Codex, Antigravity) corren su **propio loop** y se manejan vía `HostAdapter`, no vía `getProvider`.

---

## 2. Mapa de componentes

```mermaid
flowchart LR
    subgraph IF["Interfaces / Entry points"]
        CLI["CLI<br/>cli.ts"]
        MCP["MCP server<br/>mcpserver/server.ts"]
        API["HTTP API<br/>server/api.ts"]
        UI["Web UI React<br/>web/"]
        TUI["TUI Ink<br/>interactive/menu.ts"]
        ADP["Adapters cross-tool<br/>adapters/*"]
    end

    subgraph CORE["Núcleo de ejecución"]
        GRAPH["graph.ts · runAgent"]
        ORCH["orchestrator.ts · orchestrate"]
        RUNH["hosts/run.ts · runOnHost"]
        CTXM["context/manager.ts"]
        GATES["hooks/gates.ts"]
        PROV["providers/*"]
        TOOLS2["tools/*"]
    end

    subgraph DUR["Estado durable (MongoDB + Atlas)"]
        MS["MemoryStore"]
        ADRS["ADRStore"]
        PS["PromptStore"]
        DS["DefinitionStore<br/>agents · skills"]
        RM["RepoMap"]
        EMB["Embedder<br/>ingest/embedder.ts"]
        DB[("MongoDB / Atlas<br/>db/client.ts")]
    end

    CLI --> GRAPH & ORCH & RUNH & MS & ADRS & PS & DS & RM
    MCP --> MS & ADRS & PS & DS & RM
    API --> MS & ADRS & PS & DS
    UI --> API
    TUI --> CLI
    ADP --> MS & ADRS

    GRAPH --> PROV & TOOLS2 & CTXM & MS
    GRAPH --> GATES
    ORCH --> GRAPH
    RUNH --> RUNH
    TOOLS2 --> GATES
    MS & ADRS & PS & DS & RM --> DB
    MS --> EMB
```

---

## 3. Flujo de un *run* de agente (`runAgent`)

`runAgent(prompt, project, opts)` (`orchestration/graph.ts:89`) es la estrategia principal:
conduce el loop, llama al modelo, ejecuta herramientas (pasando por *gates*), y emite eventos de
traza en cada paso.

```mermaid
sequenceDiagram
    autonumber
    actor U as Usuario / Host
    participant R as runAgent<br/>graph.ts:89
    participant H as hydrate<br/>lifecycle.ts:180
    participant SK as routeSkills<br/>projectctx/router.ts
    participant P as Provider<br/>OpenRouter
    participant G as ToolRegistry+Gates<br/>tools/base.ts:57
    participant S as MemoryStore<br/>memory/store.ts
    participant DB as MongoDB

    U->>R: prompt, project, opts
    R->>S: crear Run + append Message(user)
    R->>H: hydrate(project, prompt)
    H->>S: vector → text → recency
    H-->>R: preamble (memory/decisions/conventions/repomap)
    R->>S: logEvent("hydrate")
    R->>SK: routeSkills(project, prompt)
    SK-->>R: skills + preamble
    R->>S: logEvent("skills_route")

    loop hasta maxIters o sin tool_calls
        R->>R: ¿overBudget? → ContextManager.compact()
        R->>P: chat(convo, tools)  (con retry+backoff)
        P-->>R: ChatTurn {text, tool_calls, usage}
        R->>S: append Message(assistant) + logEvent("loop_iter")
        alt hay tool_calls
            loop por cada tool_call
                R->>G: call(name, args, onDeny)
                alt gate deniega
                    G-->>R: "[denied by gate]"
                    R->>S: logEvent("gate")
                else permitido
                    G-->>R: resultado de tool.run()
                    R->>S: logEvent("tool_call")
                end
                R->>S: append Message(tool)
            end
        else sin tool_calls
            R->>R: verify() opcional → break
        end
    end

    R->>S: summarizeSession() → upsertMemory + logEvent("session_summary")
    R->>DB: Run.status = "done"
    R-->>U: {run_id, final_text, iters, summary_slug, gate_denials}
```

**Eventos de traza emitidos** (colección `events`, `memory/schemas.ts:126`): `hydrate`,
`skills_route`, `loop_iter`, `tool_call`, `gate`, `compaction`, `retry`, `verify`,
`session_summary`, `spawn`, `synthesis`, `resume`, `error`.

> Los *hooks* de sesión (`hydrate`, `routeSkills`, `summarizeSession`) son **best-effort**: si
> fallan, se capturan y se loguean — **nunca rompen el run**.

---

## 4. Intercepción de herramientas: `ToolRegistry` + gates

Cada llamada a herramienta pasa por `ToolRegistry.call()` (`tools/base.ts:57`), que ejecuta los
*gates* en orden; la primera denegación bloquea la ejecución.

```mermaid
flowchart TB
    CALL["registry.call(name, args, onDeny)"] --> G1{"gate 1<br/>denyPathsGate<br/>gates.ts:20"}
    G1 -- deniega --> DENY["onDeny(reason)<br/>return '[denied by gate]'"]
    G1 -- permite --> G2{"gate 2<br/>PhaseGate (TDD)<br/>gates.ts:36"}
    G2 -- deniega --> DENY
    G2 -- permite --> RUN["tool.run(args)<br/>try/catch — nunca crashea"]
    RUN --> RES["resultado (string)"]
    DENY --> EV1["logEvent('gate')"]
    RES --> EV2["logEvent('tool_call')"]
```

Gates por defecto (`installDefaultGates`, `gates.ts:57`): bloquean `.git/*`, `*.env`, `*.pem`,
`*id_rsa*` sobre `write_file`/`shell`. Herramientas concretas: `ReadFileTool`, `WriteFileTool`
(`tools/filesystem.ts`), `ShellTool` (`tools/shell.ts`).

---

## 5. Orquestación: master → sub-agentes (fan-out)

`orchestrate(master, project, opts)` (`orchestration/orchestrator.ts:63`) **no es un loop**:
descompone una tarea, lanza N `runAgent` en paralelo (memoria compartida) y **sintetiza** los
resultados.

```mermaid
flowchart TB
    M["orchestrate(master)"] --> DEC["planSubtasks(master, provider)<br/>(LLM divide en subtareas independientes)"]
    DEC --> T1["runAgent(tarea 1)<br/>ContextManager propio"]
    DEC --> T2["runAgent(tarea 2)"]
    DEC --> TN["runAgent(tarea N)"]
    T1 & T2 & TN --> POOL["Promise.allSettled<br/>logEvent('spawn') por subtarea"]
    POOL --> SY["provider.complete(synth)<br/>logEvent('synthesis')"]
    SY --> OUT["OrchestrateResult<br/>{run_id, final_text, subagents[]}"]

    DBSHARED[("MongoDB compartida")]
    T1 -.escribe.-> DBSHARED
    T2 -.escribe.-> DBSHARED
    TN -.escribe.-> DBSHARED
    SY -.lee.-> DBSHARED
```

Cada sub-agente tiene su **propio `ContextManager`** (los contextos no se mezclan) pero comparten
la misma MongoDB, así el sintetizador ve todos los resultados.

---

## 6. Dos formas de ejecutar: harness-conduce vs. host-conduce

```mermaid
flowchart LR
    subgraph A["host = model (el harness conduce)"]
        RA["runAgent<br/>graph.ts:89"] --> PRV["Provider (anthropic / openrouter /<br/>lmstudio / openai-compat + fallback)"]
        RA --> TLS["tools + gates"]
        RA --> EV["eventos detallados:<br/>loop_iter, tool_call, gate…"]
    end
    subgraph B["host = claude-code / codex / antigravity"]
        RO["runOnHost<br/>hosts/run.ts:33"] --> HA["CliHostAdapter<br/>spawn CLI externo"]
        HA --> OWN["el host corre SU PROPIO loop"]
        RO --> WRAP["el harness envuelve:<br/>hydrate + spawn + capture + status"]
    end
```

- **`host: model`** → el harness conduce el loop con `model` vía uno de los providers crudos
  (`anthropic`/`openrouter`/`lmstudio`/`openai-compat`, con fallback entre ellos — ADR-0044);
  queda el modelo exacto en el run.
- **`host: claude-code|codex|antigravity`** → `CliHostAdapter` (`hosts/base.ts:50`) lanza el CLI
  (`HOST_SPECS`, `hosts/base.ts:43`; override por env `AITL_HOST_CMD_<NAME>`). El harness aporta la
  capa durable alrededor (hidratación de contexto, evento `spawn`, captura de la transcripción).

---

## 7. Estado durable: colecciones y relaciones

Fuente de verdad de colecciones: `COLLECTIONS` en `db/client.ts:18`. Tres llevan `embedding` y se
indexan para Atlas Vector Search: `VECTOR_COLLECTIONS = ["messages","memory","decisions"]`
(`db/indexes.ts:16`).

```mermaid
erDiagram
    runs ||--o{ messages : "run_id"
    runs ||--o{ events : "run_id"
    runs ||--o| memory : "summarizeSession → slug"
    memory ||--o{ memory : "links [[wiki]]"
    decisions ||--o{ symbols : "Architect ↔ components"
    symbols ||--o{ symbols : "refs (PageRank)"

    runs {
        string project
        string model
        string status "running|done|error"
        obj token_usage
        date started_at
    }
    messages {
        string run_id
        int idx
        string role "user|assistant|tool|system"
        string content
        arr tool_calls
        vec embedding "384d"
    }
    memory {
        string project
        string slug PK "unique (project,slug)"
        string type "user|feedback|project|reference|synthesis"
        string category "auto-clasificado"
        arr links
        vec embedding "384d"
    }
    decisions {
        string project
        string id PK "unique (project,id) — ADR NNNN"
        string title
        string context
        string decision
        string consequences
        vec embedding "384d"
    }
    symbols {
        string project
        string file
        string name
        float pagerank
        arr refs
    }
    conventions {
        string project
        string scope_glob
        string rule
        string severity "info|warn|error"
    }
    prompts {
        string project
        string prompt
        string source "cli|mcp|ui"
        arr tags
    }
    events {
        string run_id
        string type "loop_iter|tool_call|gate|spawn|…"
        obj payload
        date ts
    }
```

**Colecciones canónicas (`COLLECTIONS`, 13):** `runs`, `messages`, `memory`, `decisions`,
`prompts`, `mcp_context`, `mcp_tool_calls`, `users`, `audit`, `symbols`, `conventions`,
`categories`, `events`.
**Satélites (fuera de `COLLECTIONS`, por paridad Python↔TS):** `agents`, `skills` (vía
`DefinitionStore`).

| Store | Colección(es) | Clave única | Archivo |
|---|---|---|---|
| `MemoryStore` | `memory`, `messages`, `events`, `runs` | `(project, slug)` | `memory/store.ts:18` |
| `ADRStore` | `decisions` | `(project, id)` | `decisions/adr.ts` |
| `PromptStore` | `prompts` | — | `prompts/store.ts:13` |
| `DefinitionStore` | `agents`, `skills` | `(project, name)` | `projectctx/store.ts:19` |
| `RepoMap` | `symbols` | `(project, file/name)` | `repomap/store.ts` |

---

## 8. Conexión resiliente a MongoDB (Atlas + fallback)

`connectWithFallback()` (`db/client.ts:95`) prueba el URI primario y, si falla, el de respaldo —
permite migrar local ↔ Atlas sin tocar código (ADR-0002). La config se resuelve por capas
(`config.ts:62`): `process.env > ~/.aitl/config.json > defaults de zod`.

```mermaid
flowchart TB
    START["connectWithFallback()"] --> CACHE{"¿_client ya activo?"}
    CACHE -- sí --> PINGOK["ping barato → reusar"]
    CACHE -- no --> P1["intentar MONGODB_URI (primary)"]
    P1 -- ping ok --> SET1["_activeUri = primary ✓"]
    P1 -- falla --> P2["intentar MONGODB_URI_FALLBACK"]
    P2 -- ping ok --> SET2["_activeUri = fallback ✓"]
    P2 -- falla --> ERR["Error: All MongoDB URIs failed"]
```

> Nota operativa: si el `.env` no se carga en el shell (p. ej. arrancar el MCP sin él), el URI cae
> al default `mongodb://localhost:27017` y la conexión a Atlas no ocurre. `src/config.ts` hace
> `import 'dotenv/config'` y `normalizeMongoUri()` (`config.ts:13`) repara URIs JSON-escapados.

---

## 9. Ciclo de vida de la memoria

`hydrate → (run) → classify → embed → summarizeSession → synthesize`. Cada paso con LLM tiene un
**fallback determinista** (el sistema funciona sin proveedor).

```mermaid
flowchart LR
    H["hydrate()<br/>lifecycle.ts:180"] --> RUN["run del agente"]
    RUN --> SUM["summarizeSession()<br/>lifecycle.ts:251"]
    SUM --> CLS["Classifier<br/>reglas → LLM<br/>memory/classifier.ts"]
    CLS --> EMB["embedOne()<br/>384d"]
    EMB --> UP["upsertMemory(type=project)"]
    UP --> TRIG{"¿supera límites?<br/>memoryMaxDocs=500<br/>memoryMaxTokens=200k"}
    TRIG -- sí --> SYN["Synthesizer<br/>agrupa por category<br/>memory/synthesizer.ts"]
    SYN --> UP2["upsertMemory(type=synthesis)<br/>logEvent('synthesis')"]
    TRIG -- no --> END["fin"]
```

### Cascada de recuperación (en `hydrate` y en búsqueda)

Funciona aunque el índice vectorial de Atlas no exista todavía: **vector → texto → recencia**.

```mermaid
flowchart TB
    Q["query / prompt"] --> V{"$vectorSearch<br/>(Atlas, embedding)"}
    V -- hits --> R["render con presupuesto<br/>de tokens"]
    V -- vacío/error --> T{"$text index<br/>(léxico)"}
    T -- hits --> R
    T -- vacío/error --> REC["find().sort(updated_at desc)<br/>(recencia)"]
    REC --> R
```

**Clasificador** (`memory/classifier.ts`): reglas-primero (regex por categoría:
decision/convention/bug/task/reference) y **LLM solo como desempate** si hay proveedor.
`TRIGGER_CATEGORIES = {decision, bug, convention, reference}` marca qué resúmenes se guardan.

**Embeddings** (`ingest/embedder.ts`): `LocalEmbedder` (Xenova `all-MiniLM-L6-v2`, 384d, sin API
key) por defecto; `VoyageEmbedder` (1024d) opcional. `embeddingDims` **debe** coincidir con el
índice vectorial (`db/indexes.ts:67`).

---

## 10. Repo map: símbolos + PageRank

```mermaid
flowchart LR
    SRC["archivos del repo"] --> PARSE["parseFile()<br/>tree-sitter (.wasm)<br/>→ fallback regex<br/>repomap/parser.ts"]
    PARSE --> DEFS["defs [name, kind]<br/>+ refs (identificadores)"]
    DEFS --> RANK["rankSymbols()<br/>PageRank α=0.85<br/>repomap/ranker.ts"]
    RANK --> SEL["selectWithinBudget()<br/>top símbolos por score"]
    SEL --> STORE["upsert symbols<br/>repomap/store.ts"]
    STORE --> RENDER["RepoMap.render()<br/>→ preamble de hidratación"]
```

`RepoMap.build()` construye el grafo de dependencias (fichero → símbolo definido en otro),
corre PageRank y guarda `pagerank` por símbolo; `render()` selecciona los más centrales dentro de
un presupuesto de tokens y los inyecta en la hidratación.

---

## 11. Superficie de interfaces

```mermaid
flowchart TB
    subgraph HUMANO["Humano"]
        T1["aitl CLI"]
        T2["Web UI (navegador)"]
        T3["TUI interactiva"]
    end
    subgraph AGENTE["Agente externo (Claude Code, Cursor…)"]
        A1["MCP (stdio / HTTP)"]
        A2["hooks: hydrate / capture-session"]
    end

    T1 --> CORE2["núcleo + stores"]
    T2 --> APIH["HTTP API /api/*<br/>server/api.ts"] --> CORE2
    T3 --> SUP["supervisa procesos<br/>mcp + ui"]
    A1 --> MCPS["MCP server<br/>mcpserver/server.ts"] --> CORE2
    A2 --> CORE2
    CORE2 --> DB2[("MongoDB / Atlas")]
```

### 11.1 CLI (`src/cli.ts`) — comandos principales

| Grupo | Comandos |
|---|---|
| DB | `check-db`, `init-db`, `migrate-atlas <uri>` |
| Memoria | `ingest`, `search`, `synthesize` |
| Ejecución | `run`, `run-host --host`, `orchestrate --max` |
| Repo/ADR | `repomap`, `adr-sync` |
| Cross-tool | `export --adapter <name>` |
| MCP / UI / TUI | `mcp [--http]`, `ui`, `interactive` |
| Prompts | `prompt {add,list,search}` |
| Guía | `init agent` |
| RBAC | `user {bootstrap,create,list,set-role,disable,verify}` |
| Config | `config {path,show,set,unset,export,import}` |
| Hooks | `hydrate`, `capture-session` |
| Eval | `eval --models` |

### 11.2 MCP server (`src/mcpserver/server.ts`) — herramientas expuestas

```mermaid
flowchart LR
    subgraph MEM["Memoria"]
        m1["search_memory"]
        m2["write_memory"]
        m3["ingest_path"]
    end
    subgraph CTX2["Contexto MCP"]
        c1["save_mcp_context"]
        c2["list_mcp_context"]
        c3["search_mcp_context"]
    end
    subgraph PR["Prompts"]
        p1["record_prompt"]
        p2["list_prompts"]
        p3["search_prompts"]
    end
    subgraph DEC["Decisiones"]
        d1["list_decisions"]
        d2["record_decision"]
    end
    subgraph DEFN["Definiciones"]
        a1["write/get/list/search/delete_agent"]
        s1["write/get/list/search/delete_skill"]
    end
    subgraph OTH["Otros"]
        o1["get_repomap"]
        o2["graphify (json|dot)"]
    end
```

Cada tool pasa por `runLogged()` (mide, audita y persiste en `mcp_tool_calls`) y por `guardTool()`
(RBAC para tools mutadoras). Transportes: **stdio** (local) y **Streamable HTTP** (remoto, con
Bearer opcional). El actor por defecto es `agent` (override por `AITL_MCP_ACTOR_*`).

### 11.3 HTTP API + Web UI

`server/api.ts` expone REST bajo `/api/*` (health, projects, memory CRUD + search, decisions,
prompts, users) con RBAC por Bearer token (`AITL_WEB_TOKENS`) y auditoría en cada acción.
`server/ui.ts` (`startUi`) arranca la API (puerto 4317) y un SPA React/Vite (puerto 5317). La UI
(`web/`) tiene pestañas **Memory | Decisions | Prompts** con selector de proyecto.

---

## 12. Adapters cross-tool (exportar el "canon")

`aitl export --adapter <name>` proyecta el *canon* del proyecto (conventions + decisions + AGENTS.md)
al formato nativo de cada herramienta (`adapters/base.ts:39`, registro en `getAdapter`).

```mermaid
flowchart LR
    CANON["Canon<br/>conventions + decisions + AGENTS.md"] --> AD{"getAdapter(name)"}
    AD --> a1["agents_md → AGENTS.md"]
    AD --> a2["cursor → .cursor/rules/aitl.mdc"]
    AD --> a3["copilot → .github/copilot-instructions.md"]
    AD --> a4["antigravity → GEMINI.md"]
    AD --> a5["kiro → .kiro/steering/*.md"]
    AD --> a6["trae → .trae/rules/project_rules.md"]
```

La dirección inversa (importar `AGENTS.md` → `conventions`) la hace `conventions/loader.ts`
(`parseAgentsMd`). `init/agent.ts` genera un `AGENTS.md` que instruye al agente a **consultar el MCP
antes de decidir** y **persistir después** (record_decision / write_memory / record_prompt).

---

## 13. Evaluación (DSR)

`EvalRunner` (`eval/runner.ts:40`) mide el *delta* del harness: corre cada modelo **con harness**
(memoria durable + tools + repo map) y opcionalmente **sin harness** (modelo desnudo) sobre un
`Benchmark { name, tasks(), verify() }`, y escribe `MetricRecord`. Los benchmarks concretos
(SWE-bench, Terminal-Bench, Aider) están deferidos (requieren datasets externos + sandbox).

---

## 14. Invariantes de diseño (resumen)

1. **Puertos y adaptadores** — el núcleo solo conoce `ProviderPort/ToolPort/MemoryPort/LoopStrategy`.
2. **Providers detrás de un único puerto** — *(enmendado por ADR-0044; el enunciado original
   "un único gateway = OpenRouter" quedó SUPERSEDED)*: cuatro backends crudos
   (`anthropic` directo + `openrouter`/`lmstudio`/`openai-compat` sobre `OpenAIProvider`)
   resueltos por `getProvider`, con cadena de fallback (`--model auto`); hosts externos vía `HostAdapter`.
3. **Un único punto de escritura** — toda persistencia pasa por los *stores* → MongoDB.
4. **Dos grafos complementarios** — *conocimiento* (`graphify`: memoria/símbolos) y *procedencia*
   (eventos/`runs`). La tesis necesita ambos.
5. **Best-effort en los hooks** — hidratación/resumen/routing nunca rompen el run.
6. **Cascada con degradación** — vector → texto → recencia: funciona sin índice vectorial.
7. **Fallback determinista** — cada paso con LLM tiene alternativa sin LLM.
8. **Conexión resiliente** — primary → fallback URI; migración local↔Atlas sin código.
9. **Gates deterministas** — la seguridad del shell/paths es un gate, no un acuerdo con el agente.
10. **Cambios arquitectónicos = ADR** — registrados en `decisions` vía `record_decision`
    (próximo id libre: **0024**).

---

## 15. Índice de símbolos clave

| Símbolo | Archivo:línea |
|---|---|
| `ProviderPort` / `ToolPort` / `MemoryPort` / `LoopStrategy` | `contracts.ts:75/84/92/101` |
| `getProvider` | `providers/base.ts:51` |
| `OpenAIProvider` | `providers/openai.ts:21` |
| `ToolRegistry.call` | `tools/base.ts:57` |
| `denyPathsGate` / `PhaseGate` | `hooks/gates.ts:20/36` |
| `HostAdapter` / `CliHostAdapter` / `getHost` | `hosts/base.ts:28/50/96` |
| `runOnHost` | `hosts/run.ts:33` |
| `runAgent` / `buildGraph` | `orchestration/graph.ts:89/321` |
| `orchestrate` | `orchestration/orchestrator.ts:63` |
| `ContextManager` | `context/manager.ts:19` |
| `MemoryStore` | `memory/store.ts:18` |
| `hydrate` / `summarizeSession` | `memory/lifecycle.ts:180/251` |
| `Classifier` | `memory/classifier.ts` |
| `Synthesizer` | `memory/synthesizer.ts` |
| `ADRStore` | `decisions/adr.ts` |
| `PromptStore` | `prompts/store.ts:13` |
| `DefinitionStore` | `projectctx/store.ts:19` |
| `routeSkills` | `projectctx/router.ts` |
| `RepoMap` (build/render) | `repomap/store.ts` |
| `rankSymbols` (PageRank) | `repomap/ranker.ts:23` |
| `COLLECTIONS` / `VECTOR_COLLECTIONS` | `db/client.ts:18` / `db/indexes.ts:16` |
| `connectWithFallback` | `db/client.ts:95` |
| `getEmbedder` / `embedOne` | `ingest/embedder.ts` |
| `EvalRunner` | `eval/runner.ts:40` |
| Schemas (Run/Message/MemoryDoc/ADR/Symbol/Event…) | `memory/schemas.ts:34–133` |
```
