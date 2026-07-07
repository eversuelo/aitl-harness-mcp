# CLAUDE.md — AITL-Harness-JS

## Project identity (read first)

This repo is backed by the **aitl-js MCP memory backend**. To keep durable state
(decisions, memory, prompts, skills, agents, context) in ONE place, always use the
canonical project key below — never invent variants from the directory or package name.

| Field | Value |
|-------|-------|
| **Canonical MCP project key** | `aitl-js` |
| **Project hash** | `79cdb3578a8f619c` (`sha256("aitl-js")[:16]`) |

**Rule for every agent / tool call against the `aitl-js` MCP server:** pass
`project: "aitl-js"`. Do **not** use `AITL-Harness`, `AITL-Harness-JS`, or any other
spelling — those fragment the history. Verify the hash above matches
`sha256(project_key)[:16]` before writing if in doubt.

> History note (2026-06-24): durable state had been split across `aitl-js` (the real
> history: ADRs 0001–0009, prompt log, Codex context) and a stray `AITL-Harness-JS` key
> created by mistake. They were merged into `aitl-js`: the stray ADRs were renumbered
> 0010–0013 and the stray key was emptied. ADRs were contiguous 0001–0013 right after
> the merge; subsequent work extended the ledger, which is now contiguous **0001–0033**
> (verified against the `decisions` collection on 2026-06-29; ledger now contiguous
> **0001–0035**; next free **0036**).
> 0036: capa de datos migrada a **Mongoose** (reemplaza Zod + driver crudo; misma conexión
> srv, sin shards; modelos en `src/models/*.model.ts`). 0037: repo-map por rama (campo
> `branch` en el modelo Symbol, huella constante, respeta `.gitignore`). Ledger ahora
> contiguo **0001–0037**; next free **0038**.
> 0038–0042 (2026-07-01, rama `feat/p1-p2-harness-core`): 0038 providers locales
> lmstudio/openai-compat (maxContext configurable); 0039 hooks pre/post tool en la
> ToolRegistry; 0040 gates async + aprobación humana in-loop `--ask` (métrica
> `supervision_minutes` en run-show); 0041 cliente MCP (`--mcp` monta `.mcp.json` como
> tools `mcp__<server>__<tool>`); 0042 SDD Fase D (`aitl sdd`, memory types
> spec/design/task + RESERVED_MEMORY_TYPES). Además se implementaron ADR-0005
> (`chatStream` + `aitl run --stream`) y ADR-0003 (`aitl chat` REPL multi-turno).
> 0043 (primera corrida viva, gemma-4 vía LM Studio): fixes de round-trip
> provider↔loop — `toOpenAiMessages` adapta tool_calls al formato OpenAI,
> `MessageModel.content` acepta `""` (turno solo-tools), extractor de array JSON
> balanceado en `decomposeTasks`. Loop verificado E2E con tools+stream+`--ask`.
> 0044 (2026-07-02, enmienda a 0020): provider `anthropic` directo (SDK oficial,
> caching + structured outputs + tool blocks nativos; `src/providers/anthropic.ts`);
> constrained decoding opt-in (`CompleteOpts.jsonSchema` → response_format/output_config,
> usado por `decomposeTasks`); `AITL_API_KEY` único clasificado por prefijo;
> `aitl models` (providerStatus) + `FallbackProvider` (`--model auto` con cadena de
> fallback); chat estilo Claude Code (`src/repl/chat.ts`, hook `onTool`, slash commands)
> + submenu Chat en el TUI. 0045 (2026-07-05): hardening del CLI — fix del robo de stdin
> del TUI al chat hijo ("pulsar dos veces la tecla"; suspend() pausa stdin), spinner
> idempotente, teardown en SIGINT, deadline de streaming (`AITL_STREAM_IDLE_MS`),
> ToolRegistry por sub-agente en orchestrate, preAction fail-fast, tree-kill POSIX,
> ShellTool maxBuffer+clip, parseLimit en la API.
> 0046 (2026-07-05, rama `feat/harness-v2`): auth web de sesión — colección `sessions`
> (solo sha256 del token, índice TTL), `POST /api/auth/login|logout`, cascada
> sesión→AITL_WEB_TOKENS→anónimo, split 401 login_required / 403, escrituras web
> autenticadas como delegated (mismo modelo que guardTool del MCP), CORS por allowlist
> `AITL_WEB_ORIGINS`, cliente web con Authorization + diálogo de login. Cierra el
> hallazgo Alto de la auditoría 2026-07-05.
> 0047–0048 (2026-07-06): retiro de LangGraph (runAgent loop único, resumible desde el
> transcript durable; fuera buildGraph/checkpointer/deps, un solo driver mongodb@7
> deduplicado) y conexión Mongo única con Mongoose dueño (db/client.ts = capa compat,
> getDb() ya no autoconecta) + factories makeX() async con `await doc.validate()`
> (validateSync deprecado; util/quiet.ts borrado) + retiro de `aitl eval` (C0 =
> `run --bare`, C2 = default).
> 0049 (2026-07-06): memoria/ADRs anclados a commit (`commit_sha` estampado en stores y
> síntesis; `synthesize --at <ref>`) + ciclo de vida de ADRs (`deprecated` + motivo +
> `superseded_by` + `review_after` TTL suave que excluye de hydrate sin borrar +
> `components[]`; tool `deprecate_decision`, CLI `aitl adr deprecate`,
> `proposeDeprecations` solo propone) + `aitl branch sync --reindex` (head de la base
> avanzó → indexador maestro). `consequences` ya no es required (Mongoose rechaza "" en
> String required).
> 0050 (2026-07-06): signup self-service (email/username únicos con 409 distinguible,
> `AITL_WEB_ALLOW_SIGNUP`, primer usuario real→admin; `aitl user register`) + config
> del harness desde la web UI (`GET /api/config/status`, `PUT /api/config`, pestaña
> Config root/admin) con espejo automático al `.env` (`src/config/envfile.ts`;
> `aitl config set --env`); matriz RBAC: `config_secrets` gana admin:delegated.
> 0051 (2026-07-06): sync markdown bidireccional (`aitl sync [--pull|--push]`) — espejo
> legible en `.aitl/{memory,skills,agents}/` + `docs/adr/` (serie 0001–0050 completa),
> manifiesto de dos hashes (cambió-vs-propia-línea-base), conflictos sin merge (exit 2),
> borrados nunca se propagan; `export --adapter markdown`. Ledger ahora contiguo
> **0001–0051**.
> 0052 (2026-07-06): `aitl init` — bootstrap de repo en un comando (idempotente,
> [ok|skip|done]: DB+root, software→repo→branch, indexRepo, seeds, guías y
> .mcp.json/.claude/settings.json con merges conservadores, post-merge hook,
> `--memory-only`) + degradación sin backend (auto = cadena de fallback también en
> run; NO_BACKEND_MESSAGE accionable; synthesize extractivo con aviso). Ledger ahora
> contiguo **0001–0052**. El espejo docs/adr lo mantiene `aitl sync` (ADR-0051).
> 0053 (2026-07-06): mapa de módulos (`repomap --modules`, view/back/mixed/infra por
> extensión+segmentos con override `.aitl/modules.json`, descenso de un nivel en dirs
> dominantes >80%) + `module-brief <dir>` (bloque del módulo + ADRs por `components[]`
> + memorias `component:<dir>`) + tools MCP `get_module_map`/`get_module_brief`.
> Ledger ahora contiguo **0001–0053**.
> 0054 (2026-07-06): coordinación mínima (ADR-0002 de la tesis, rebanada v1) —
> `task_claims` con lock por índice único parcial (released:false) + caducidad
> (AITL_CLAIM_TTL_MS), `coord_events`, tools MCP claim_task/release_task/poll_events
> (recurso RBAC `coordination`), CLI `aitl coord {claim,release,list,poll}` con cursor
> incremental; `record_decision` emite evento decision best-effort; `aitl init`
> instala el hook Stop `coord poll --quiet`. Ledger ahora contiguo **0001–0054**.
> 0055 (2026-07-06): plan-council (ADR-0003 de la tesis, rebanada v1) — `src/council/`
> {ports,rubric,adapters,orchestrator}: Zod PlanProposal/PlanCritique/CouncilVerdict,
> HostClientAdapter en SOLO LECTURA (`readonlyArgs` por spec: claude-code
> `--permission-mode plan`, codex `--sandbox read-only`) + ProviderClientAdapter
> (jsonSchema), rúbrica ponderada determinista, rondas proponer-paralelo →
> criticar-anonimizado (nunca la propia) → juez ≠ proponentes, 1 retry citando el
> error Zod → sin-voto con quórum ≥2, presupuesto duro N×R; telemetría run kind
> `council` + eventos `council_*` + veredicto como memoria `design` (best-effort,
> degrada sin backend); CLI `aitl council "<task>" --hosts a,b [--judge] [--rounds]
> [--json]`; E2E con hosts fake vía `AITL_HOST_CMD_*`. OJO: `aitl sync` sin
> `--project` cae al basename del cwd (`AITL-Harness-JS`) y ve Mongo vacío — usar
> siempre `--project aitl-js`. Ledger ahora contiguo **0001–0055**; next free **0056**.
> 0056 (2026-07-06): rama «Task» del panel interactivo (P9) — entrada de primer nivel
> (atajo `t`) en el supervisor readline: al entrar arranca el MCP best-effort y lanza
> `coord poll --quiet` como notificaciones no bloqueantes; disponibilidad como
> funciones puras (`src/interactive/taskLogic.ts`: sonda PATH + override
> `AITL_HOST_CMD_*`, `planCouncilSeats` ≥2 proponentes + juez distinto,
> `computeTaskActions` con razón legible); flujos in-process bajo `suspend()`
> (`task.ts`, TaskIO inyectable): Planear = `runSddPipelinePreview`
> (confirm-before-persist, `BufferMemoryStore`), Delegar = wrap `runOnHost` (degrada a
> host directo sin Mongo), Council = `runCouncil` + handoff «delegar el plan ganador».
> Degradación F9: sin Mongo corre sin persistir con aviso. 19 tests nuevos (268).
> Ledger ahora contiguo **0001–0056**; next free **0057**.
> 0057 (2026-07-06): documentación consolidada — docs/ARQUITECTURA.md es EL canónico
> (actualizado post-0056: ciclo v2, CLI/MCP al día, sin LangGraph/eval); lo histórico
> (ARQUITECTURA-AITL-JS.md, docs/thesis/*, docs/sessions/*) se archivó en docs/attic/;
> docs/adr/README.md ya no mantiene tabla a mano (el directorio es espejo completo del
> ledger vía `aitl sync --project aitl-js`). Ledger ahora contiguo **0001–0057**;
> next free **0058**.
> 0058 (2026-07-07): permisos explícitos en el argv de los hosts — la postura de permisos
> viaja SIEMPRE en el argv (nunca settings/trust del cwd destino): `CliHostSpec.writeArgs`
> (claude-code `--permission-mode acceptEdits` por defecto en corridas delegadas),
> resolución pura `resolveHostSpec` en capas (args → writeArgs → `AITL_HOST_ARGS_<NAME>`
> → extraArgs → readonlyArgs AL FINAL: el solo-lectura del council siempre gana),
> CLI `run-host --permission-mode/--allowed-tools`. 12 tests nuevos (280).
> Ledger ahora contiguo **0001–0058**; next free **0059**.
> 0032: instrumentación del piloto — slice Schoolar T1/T3, condiciones C0/C2 (`--bare`),
> `aitl run-show`, y quality gate en el loop (`aitl run --verify-cmd`).
> 0033: roles de ingeniería componibles (H11) review/pair/gate que asisten al ingeniero
> (DecisionBrief, objeciones atribuidas) + métrica de supervisión humana (`aitl intervene`).
> 0034: tokens en `run-host` (Cara B) vía `claude -p --output-format json` — levanta el
> bloqueador del piloto (métrica #7 sin OPENROUTER_API_KEY) — + Pilar 4 SDD (auto-clasificación
> de specs `src/specs/`, prompt persistido + síntesis spec↔tarea) + pestaña UI "Runs".
> (0034 tb: `capture-session` registra runs humanos con tokens reales del transcript.)
> 0035: grafo por sesión — `capture-session` extrae artifacts (ADRs/memorias/prompts) del
> transcript y los liga al run; `src/graph/session.ts` + `GET /api/runs/:id/graph` + SessionGraphView.
> Ciclo 0026–0031 (2026-06-28): 0026 auto-bootstrap de root local; 0027 versionamiento
> append-only de ADRs/memoria (`*_history`); 0028 jerarquía software→projects→repos +
> sub-scope `repo`; 0029 knowledge map multi-entidad (graphify + UI); 0030 skill
> constructora + indexador maestro + hook de seed; 0031 clasificación de ramas + grafo
> de branches estilo GitHub.

## Stack

Model-agnostic agent harness. TypeScript (ESM, Node ≥ 20) · loop propio `runAgent`
(`src/orchestration/graph.ts`: prompt→modelo→tools→repeat, resumible desde el transcript
durable; sin framework de grafos) · MongoDB + Atlas Vector Search as the single durable
store (conexión única, dueño Mongoose: `src/db/mongoose.ts`) · local embeddings
(`Xenova/all-MiniLM-L6-v2`, 384 dims) by default. Connects to Atlas by seedlist with a
local fallback (`MONGODB_URI` → `MONGODB_URI_FALLBACK`); db `aitl`.

## Conventions

- Run `npm run typecheck` and `npm run build` before claiming a change is done.
- Context lookups (memory, decisions, conventions, skills) use a robust cascade
  (vector → text → recency) so they work even before the Atlas vector index exists.
- Architectural changes get an ADR via the `record_decision` MCP tool (next free id;
  currently 0046). Keep ADR ids contiguous and never reuse one. The number is the
  next-free read from the `decisions` collection at BUILD time — never pin it in docs.
