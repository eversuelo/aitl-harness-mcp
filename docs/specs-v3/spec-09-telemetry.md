## SPEC-09 — Telemetría de costo por modelo/tier + forense de sesión completa
**Requisitos que cubre:** 12 (principal: gasto por modelo + análisis de sesión incompleto); habilita la medición del 6 (tiering) y del 16 (SPEC-11 deduce capacidades desde esta telemetría); hace visible el gasto del 5 (síntesis post-llamada).

### Objetivo y motivación
Hoy el harness sabe *cuántos* tokens pasó cada run, pero no *quién* los gastó (¿qué modelo real, tras el fallback?, ¿qué tier?, ¿el loop o una llamada lateral de síntesis/roles/council?) ni *cuánto costaron* en USD — salvo cuando el host Claude Code lo regala (`cost_usd`, Cara B). Y "¿qué se hizo en esta sesión?" se responde a trozos: `run-show` da totales, el session graph da artefactos, pero no hay línea de tiempo. Esta spec añade: (a) una traza fina **`llm_calls`** — una fila por llamada al modelo, con modelo real, tier, propósito y desglose de caché; (b) un **catálogo de precios editable** (`model_prices` + seed) que convierte esa traza en **costo real USD** y **costo_pond** cache-aware por run/tier/task/sesión, computable también en Cara A; (c) **métricas de eficiencia** (costo por fase completada, por verify-pass, por iteración); (d) superficies `aitl cost report` + pestaña web «Cost»; y (e) el **forense**: `aitl session show <runId>` reconstruye el timeline narrativo completo desde `messages` + `events` + `mcp_tool_calls` + `llm_calls`, enlazado a la síntesis de SPEC-03. Todo aditivo: el rollup grueso de `runs` sigue siendo la verdad de respaldo.

### Estado actual (anclas de código verificadas)
- **Rollup por run, plano**: `src/orchestration/graph.ts` — acumuladores `tokIn/tokOut/toolCalls` (líneas 403-406; sumas también en reflect ~483 y budget-wrap ~533), persistidos al cierre como `token_usage: {input, output}` (`$set` en ~797-812). `runAgent` (graph.ts:181), `RunAgentOpts` (graph.ts:36), provider resuelto en graph.ts:186 (`opts.provider ?? await getProvider()`). El evento `loop_iter` lleva SOLO `{ iter }` (graph.ts:614): no hay tokens por iteración.
- **Usage normalizado SIN caché ni modelo**: `ChatTurn.usage = {input, output}` (`src/providers/base.ts:18`). `src/providers/anthropic.ts:116` **descarta** `cache_creation_input_tokens`/`cache_read_input_tokens` del SDK; `src/providers/openai.ts:199-200` descarta `prompt_tokens_details.cached_tokens` (Chutes/OpenRouter lo devuelven) aunque conoce `this.model` (openai.ts:131). `FallbackProvider` (base.ts:251-323) puede servir con OTRO candidato que el pedido y nada lo registra; `getProviderWithFallback` (base.ts:342).
- **Caché y costo solo en Cara B**: `src/context/capture.ts:168-174` desglosa `cache {creation, read, freshInput}` y lo persiste como `host_meta.cache` + `raw_input_tokens` (370-376); `src/hosts/base.ts:88` (`cost_usd: obj.total_cost_usd ?? null`), `src/hosts/run.ts:161,196`. **No existe catálogo de precios** en el repo.
- **Gasto invisible**: `summarizeSession` (`src/memory/lifecycle.ts:359`), el `Classifier`, `deliberate` de roles (graph.ts ~785), el council y la tool MCP `synthesize` llaman al provider sin registrar usage en NINGÚN run — el costo del tier `synthesize` de SPEC-02/03 hoy no se mediría.
- **Forense parcial**: `runs.strict:false` admite telemetría dinámica vía `$set` (`src/models/run.model.ts:49-52`); `events` con ~29 tipos (`src/models/event.model.ts:24-57`, "purely observational: never read back into a run"); `messages` con `tokens` por turno pero sin modelo (`src/models/message.model.ts:48`); `mcp_tool_calls` **sin `run_id`** (`src/models/mcpToolCall.model.ts:22-38`) — imposible ligar una llamada MCP a su run; el `spawn` del orchestrator no registra el runId hijo (`src/orchestration/orchestrator.ts:90`, payload `{index, task}`); el grafo de artefactos por sesión ya existe (`src/graph/session.ts` `assembleSessionGraph`/`sessionGraph`, basis `artifact|run_id|tag|temporal`, `GET /api/runs/:id/graph`).
- **Patrones a imitar**: agregación `toolCallsReport(match)` (`src/toolcalls/report.ts:146`, servida en `src/server/api.ts:844-852`); `RunsView` con Σ tokens/costo (`web/src/App.tsx:691`, totales en 722; union `Tab` en 67); tools MCP vía `server.tool` + `runLogged` (server.ts:311) + `TOOL_RBAC` (server.ts:241-277) + canario `mcpserver/rbac.test.ts`; `ENV_KEYS` (`src/config/store.ts:42-48`); índices en `src/db/indexes.ts`. OJO: la colección `sessions` ya existe y es **auth web** (ADR-0046, `src/models/session.model.ts`) — no reutilizar ese nombre.
- **Doctrina de conteo**: `docs/token-accounting.md` define la fórmula ponderada `fresh×1.0 + cache_creation×1.25 + cache_read×0.1` (líneas 57-66) y las 4 medidas para la métrica #7 (88-99) — es doc, no código. La tesis define `costo_pond` como "el costo en USD que reporta el propio host" (`sections/chapter-04/chapter.tex:346,369,382,424`): hoy solo Cara B lo tiene.
- **RBAC**: `RESOURCES` (`src/auth/rbac.ts:23-36`) NO incluye un recurso `config` genérico (solo `config_secrets`) — una tool de precios necesita recurso propio o reutilizar uno existente.

### Diseño

#### Modelo de datos (2 colecciones nuevas + campos aditivos)
`src/models/modelPrice.model.ts` → colección `model_prices` (catálogo editable):
```ts
const modelPriceSchema = new Schema({
  provider: { type: String, required: true },      // anthropic|openrouter|openai-compat|lmstudio|host:claude-code…
  model_prefix: { type: String, required: true },  // match por prefijo más largo: "claude-opus-4", "deepseek-ai/"…
  input_per_mtok: { type: Number, required: true },   // USD por millón de tokens de input fresco
  output_per_mtok: { type: Number, required: true },
  cache_write_mult: { type: Number, default: 1.25 },  // multiplicadores de docs/token-accounting.md
  cache_read_mult: { type: Number, default: 0.1 },
  currency: { type: String, default: "USD" },
  source: { type: String, default: "seed" },       // seed|manual|<url>
  effective_from: { type: Date, default: now },
}, { ...BASE_SCHEMA_OPTS, collection: "model_prices" });
// índice único { provider: 1, model_prefix: 1 }; resolvePrice(provider, model) = prefijo más largo; null si no hay
```
`src/models/llmCall.model.ts` → colección `llm_calls` (traza fina, una fila por llamada al modelo):
```ts
const llmCallSchema = new Schema({
  project: { type: String, required: true },
  run_id: { type: String, default: null },         // null = gasto fuera de run (p.ej. synthesize por CLI)
  parent_run_id: { type: String, default: null },  // árbol orchestrator → subagentes
  tier: { type: String, enum: ["design", "implement", "synthesize", null], default: null }, // de SPEC-02
  provider: { type: String, required: true },      // el candidato REAL que sirvió (post-fallback)
  model: { type: String, required: true },         // el modelo de la RESPUESTA, no el pedido
  purpose: { type: String, required: true },       // loop_turn|reflect|wrap_up|summarize|classify|synthesize|decompose|council|role_review|host_session
  usage: { input: Number, output: Number, cache_creation: { type: Number, default: 0 }, cache_read: { type: Number, default: 0 } },
  cost_usd: { type: Number, default: null },       // snapshot al escribir (resolvePrice); null = sin precio, JAMÁS inventado
  pond_tokens: { type: Number, default: null },    // fresh + 1.25×cache_creation + 0.1×cache_read (input-equivalente)
  price_ref: { type: String, default: null },      // "provider/model_prefix@effective_from" para auditoría
  ms: Number, ok: { type: Boolean, default: true }, error: { type: String, default: null }, ts: { type: Date, default: now },
}, { ...BASE_SCHEMA_OPTS, collection: "llm_calls" });
// índices (db/indexes.ts): { run_id: 1, ts: 1 }, { project: 1, ts: -1 }, { project: 1, model: 1, ts: -1 }
```
Campos aditivos backward-compatible: `ChatTurn.usage` gana `cache_creation?/cache_read?` y `ChatTurn` gana `model?` (base.ts:18; anthropic.ts:116 y openai.ts:199 dejan de descartarlos); `mcp_tool_calls` gana `run_id?: string`; `runs` gana `parent_run_id?` (estampado por el orchestrator vía `RunAgentOpts.parentRunId` nuevo) y el rollup `cost: { usd, pond_tokens, by_tier, by_model, by_purpose, cost_source: "host"|"computed"|"mixed", estimated }` vía `$set` (permitido por `strict:false`).

#### Módulos nuevos
- `src/telemetry/cost.ts` — puro, testeable: `resolvePrice(provider, model): Promise<ModelPrice|null>` (exacto > prefijo más largo > null); `computeCost(usage, price): { cost_usd, pond_tokens }` (fórmula exacta de token-accounting.md:57-66; output a precio de output). `PRICES_SEED` con ~12 entradas concretas y fecha de captura declarada: `claude-opus-4*` 15/75, `claude-sonnet-4*` 3/15, `claude-haiku-4*` 0.8/4, `deepseek-ai/*` ≈0.25/1 y `Qwen/*` ≈0.15/0.6 (Chutes), `zai-org/GLM-*` ≈0.6/2.2, `lmstudio/*` 0/0, `openrouter/*` null (consultar gateway). `seedPrices()` idempotente (upsert por clave única; corre en `aitl init` y `aitl cost prices seed`). Override local `.aitl/prices.json` (mismo shape; gana al catálogo; ruta en `AITL_PRICES_FILE`).
- `src/telemetry/meter.ts` — `meterProvider(p: Provider, base: MeterMeta): Provider`: decorador de `chat/chatStream/complete` que cronometra y escribe `llm_calls` **fire-and-forget con try/catch** (nunca bloquea ni tira el loop; sin Mongo ⇒ no-op, patrón best-effort de `logEvent`). `MeterMeta = { project, runId?, parentRunId?, tier?, purpose }`. Como los call-sites del loop comparten un solo provider, el `purpose` fino se re-etiqueta con AsyncLocalStorage (Node ≥20): `export const meterScope = new AsyncLocalStorage<Partial<MeterMeta>>()` + `withPurpose(purpose, fn)` — el decorador lee el scope activo y cae a `base`. Con `FallbackProvider` se mide el **candidato interno que sirvió**, no la fachada: `getProviderWithFallback` (base.ts:342) acepta `meter?: MeterMeta` y envuelve cada candidato de la cadena — así TODO consumidor (runAgent, summarizeSession, roles, council, tool MCP `synthesize`) queda cubierto sin tocar sus call-sites.
- `src/telemetry/report.ts` — estilo `toolCallsReport`: `costReport(match, by: "run"|"tier"|"model"|"provider"|"purpose"|"day")` (`$group` sobre `llm_calls`; para runs SIN traza — legado y hosts viejos — cae a `runs.token_usage`+`host_meta` y marca `estimated: true`); `costSession(runId)` agrega el árbol run+hijos por `parent_run_id`; `efficiency(runId)` cruza con `events`: `cost_per_verify_pass` (verify con `payload.ok:true`), `cost_per_iter`, `cost_per_tool_call`, `cost_per_gate_pass`; acepta `--tag fase:NN` (los runs del lab llevan `tags`, run.model.ts:47) para costo por fase del raytracer.
- `src/forensics/timeline.ts` — `buildTimeline(runId, { includeChildren }): TimelineEntry[]`: merge-sort por timestamp de (1) `messages` (rol, preview, tokens, tool_calls), (2) `events` (render específico por tipo: hydrate→secciones, verify ✓/✗, gate, stall, budget, spawn→hijo, session_summary→slug), (3) `mcp_tool_calls` correlacionadas, (4) `llm_calls` (modelo/tier/costo por turno). `TimelineEntry = { ts, kind: "turn"|"event"|"mcp_call"|"llm_call"|"artifact", actor, summary, tokens?, cost_usd?, confidence?: "exact"|"window", refs? }`. `renderTimelineAnsi()` (vía el `AnsiMarkdownStream` de `src/repl/markdown.ts`) y `renderTimelineMarkdown()` — el markdown es evidencia pegable en la bitácora y el insumo que consumen las sesiones de síntesis de SPEC-03.
- `src/forensics/correlate.ts` — `correlateMcpCalls(run)`: primero por `run_id` exacto; fallback ventana temporal `[started_at−2min, ended_at+2min]` + mismo `project`, marcado `confidence:"window"` (mismo espíritu que el basis `temporal` de graph/session.ts). `backfillMcpRunIds(project)` escribe `run_id` en las matcheadas — comando explícito, nunca automático.

#### Instrumentación (puntos de enganche exactos)
1. graph.ts:186 → `const provider = meterProvider(opts.provider ?? await getProvider(), { project, runId, parentRunId: opts.parentRunId, tier: opts.tier, purpose: "loop_turn" })`; los turnos especiales envuelven su llamada con `withPurpose`: reflect (~462), wrap-up de budget (~521), y `summarizeSession`/`Classifier` al cierre (`purpose:"summarize"|"classify"`).
2. Cierre del run (graph.ts:797-812): al `$set` existente se añaden `cost` (rollup de sus `llm_calls`) y `host_meta.cache` con la MISMA forma que capture.ts:370-376 — unifica Cara A y B.
3. `runLogged` (server.ts:311): lee `AITL_RUN_ID` del entorno del server MCP y lo estampa en `mcp_tool_calls.run_id`; `hosts/run.ts` exporta `AITL_RUN_ID` al proceso host para que sus hooks/MCP lo hereden (oportunista; la correlación por ventana es la red de seguridad).
4. `capture-session` (capture.ts) escribe además UNA fila `llm_calls` agregada por sesión-host (`provider:"host:claude-code"`, `purpose:"host_session"`, usage con el desglose ya disponible, `cost_usd` del host con `estimated:false`) — `cost report` cubre la Cara B sin caso especial; prioridad de verdad: `cost_source:"host"` > `"computed"`.
5. El `spawn` del orchestrator (orchestrator.ts:90) enriquece su payload con `child_run_id` y el hijo corre con `parentRunId` — el árbol de costos por sesión queda navegable (lo consume SPEC-06).

#### Tools MCP nuevas (patrón server.tool + runLogged + TOOL_RBAC + canario)
- `cost_report` (lectura, sin entrada RBAC): `{ project: z.string().optional(), by: z.enum(["run","tier","model","provider","purpose","day"]).default("tier"), since: z.string().optional(), run_id: z.string().optional(), tag: z.string().optional() }` → reporte JSON.
- `session_timeline` (lectura): `{ run_id: z.string(), format: z.enum(["json","markdown"]).default("markdown"), include_children: z.boolean().default(true), include_mcp_window: z.boolean().default(true) }` → el forense completo.
- `set_model_price` (muta): `{ provider: z.string(), model_prefix: z.string(), input_per_mtok: z.number(), output_per_mtok: z.number(), cache_write_mult: z.number().optional(), cache_read_mult: z.number().optional(), source: z.string().optional() }` → upsert. RBAC: recurso NUEVO `"telemetry"` añadido a `RESOURCES` (rbac.ts:23-36, aditivo) con fila en la matriz (root/admin directo, delegated con guardTool) + `TOOL_RBAC["set_model_price"] = { resource: "telemetry", action: "update" }` + canario en `mcpserver/rbac.test.ts` (no existe recurso `config` genérico — verificado).

#### CLI, API y web
```
aitl cost report  [--project] [--by tier|model|run|provider|purpose|day] [--since 2026-07-01] [--tag fase:03] [--json|--csv]
aitl cost run <runId>          # desglose por llamada + eficiencia (verify-pass, iter, tool-call, gate-pass)
aitl cost session <runId>      # árbol run+hijos con subtotales por tier
aitl cost prices {list, seed, set <provider> <prefix> --input N --output N}
aitl session list [--project] [--limit 20]     # runs recientes: fecha, modelo, stop_reason, USD, summary_slug (selector)
aitl session show <runId> [--md|--json] [--no-children]   # timeline forense; --md pegable en la bitácora IMPL
aitl session backfill [--project]              # backfillMcpRunIds + costo estimado para runs históricos (explícito)
```
`run-show` (cli.ts:466-522) añade el bloque `cost`. API junto a las rutas de runs (api.ts:826-852): `GET /api/cost/report?project=&by=&since=` y `GET /api/runs/:id/timeline`. Web: `web/src/components/CostView.tsx` — pestaña nueva `cost` en el union `Tab` (App.tsx:67): barras por tier/modelo/día, tabla por run, % `estimated`, aviso de precios stale (>90 días); columna USD en `RunsView` y sección Timeline en su detalle, reutilizando `web/src/lib/kindColors.ts`.

#### Config/env
`ENV_KEYS` (store.ts:42) += `AITL_TELEMETRY` (`on`|`off`, default `on` — kill-switch del metering fino; el rollup grueso NUNCA se apaga) y `AITL_PRICES_FILE`. Sin precios en env: el catálogo vive en Mongo y se edita por CLI/tool/web. Ambas llegan al wizard/ConfigView (las 35 ENV_KEYS de ADR-0061 crecen a 37).

### Fases de implementación
- **F1 — Catálogo de precios + motor de costo** (1 sesión): `modelPrice.model.ts` + índice único, `telemetry/cost.ts` con `PRICES_SEED`, `aitl cost prices {list,seed,set}`, tool `set_model_price` + recurso RBAC `telemetry` + canario. *Verifica*: `node --test src/telemetry/cost.test.ts` — resolución por prefijo más largo y fórmula ponderada contra los números REALES de token-accounting.md (24,779 / 963,253 / 41,367,842 → ≈5.365M pond); `npm run verify` verde.
- **F2 — Traza fina cache-aware** (1 sesión): `ChatTurn` extendido (caché + model en anthropic.ts/openai.ts), `llmCall.model.ts` + índices, `meter.ts` (decorador + ALS `withPurpose`), enganche en graph.ts:186 y candidatos de `getProviderWithFallback`, cierre del run con `cost`/`host_meta.cache`, fila agregada en capture-session/run-host. *Verifica*: unit del decorador (provider fake; Mongo caído ⇒ no-op; stream abortado registra parcial); E2E `aitl run "di hola" --bare --max-iters 1` → `llm_calls` con ≥1 fila con modelo real y costo; `aitl run-show` muestra `cost`; run Cara B → `cost_source:"host"`.
- **F3 — Reportes y superficies** (1 sesión): `telemetry/report.ts` (costReport/costSession/efficiency con fallback `estimated`), `aitl cost {report,run,session}` (+`--csv` para el lab), tool `cost_report`, rutas API, `CostView.tsx` + columna USD en Runs. *Verifica*: tests de agregación con fixtures (2 tiers + 1 run legado ⇒ `estimated:true`; Σ llm_calls ≈ token_usage del run); E2E `aitl cost report --by tier --json`; `npm run build:web`.
- **F4 — Forense de sesión** (1 sesión): `run_id` en `mcp_tool_calls` + estampado en `runLogged` + `AITL_RUN_ID` en hosts/run.ts; `parent_run_id` (`RunAgentOpts` + orchestrator; spawn gana `child_run_id`); `forensics/{timeline,correlate}.ts`; `aitl session {list,show,backfill}` + tool `session_timeline` + Timeline en la web. *Verifica*: test del merge-sort con fixture multi-fuente; E2E: `aitl run` con `--verify-cmd`, luego `aitl session show <id> --md` reconstruye prompt→turnos→tools→verify→cierre con el slug de la síntesis al final; `rbac.test.ts` verde.
- **F5 — Eficiencia + doc + cierre** (media sesión): métricas `cost_per_*` en `cost run` y `--tag fase:NN`; `docs/COSTOS.md` (catálogo, fórmula, forense, recetas) + nota en `docs/token-accounting.md` (la fórmula ahora vive en `cost.ts`) + sección en `docs/GUIA-CLI.md`. *Verifica*: `npm run verify` completo + E2E de `session backfill` sobre la BD del laboratorio (los runs del raytracer ganan costo estimado y timeline).

### ADRs a registrar
- «Catálogo de precios por modelo (`model_prices`) y traza fina `llm_calls` cache-aware: costo real + costo_pond por run/tier/propósito» — proposed.
- «Forense de sesión: timeline reconstruible desde messages+events+mcp_tool_calls+llm_calls, correlación MCP↔run y `parent_run_id`» — proposed.
- «Recurso RBAC `telemetry` y kill-switch `AITL_TELEMETRY`» — proposed (puede fundirse con el primero al implementar).

### Medición para la tesis
Esta spec ES instrumento de medición, no solo feature. Actualiza la **métrica #7 (eficiencia, ISO 25010)** de `tab:metrics` (cap. 4): `costo_pond` deja de calcularse a mano y pasa a ser salida directa de `aitl cost report` — misma fórmula, ahora auditable vía `price_ref` — y se vuelve **computable en Cara A** (chapter.tex:382 lo define hoy como "USD que reporta el host"; la enmienda: `costo_pond = cost_source host si existe, si no computed`, misma fórmula en ambas caras ⇒ celdas nativas y de host comparables). Columnas nuevas del CSV del lab: `usd_total`, `usd_por_tier`, `cost_per_verify_pass`, `cost_per_fase`. La celda `c2-tiered` (SPEC-02/SPEC-10) es la consumidora directa: sin esta spec, el tiering del requisito 6 no es medible ("¿el tiering ahorra?" = USD por tier vs mono-modelo en la misma fase). El forense cierra la queja literal del requisito 12 («el análisis de qué se hizo en cada sesión está incompleto») y `aitl session show --md` alimenta la bitácora IMPL con evidencia reproducible por corrida. Filas IMPL: una por fase F1-F5 (detalle en SPEC-10).

### Riesgos y mitigaciones
- **Doble conteo** entre `llm_calls` y `runs.token_usage` (o entre fila host y metering del wrapper): jerarquía explícita — traza fina preferida, rollup como respaldo con `estimated:true`; `purpose` distingue `host_session` de superficies propias; test que verifica Σ llm_calls ≈ token_usage.
- **Precios desactualizados** ⇒ costos falsos: `effective_from` + warning en reportes si el match tiene >90 días; `source` auditable; sin match ⇒ `cost_usd:null` reportado como «sin precio», nunca inventado.
- **Overhead/fragilidad en el hot path**: escritura best-effort con try/catch, volumen bajo (≈ iters por run), `AITL_TELEMETRY=off` como kill-switch (benchmarks y tests).
- **Correlación por ventana** puede atribuir llamadas MCP de una sesión concurrente: solo como fallback, con `confidence:"window"` visible en el timeline y backfill siempre manual.
- **FallbackProvider enmascara el modelo real**: se mide dentro de la cadena (el candidato que sirvió) y `model` viene de la RESPUESTA; el fix 404 de SPEC-02 garantiza que un candidato muerto registre `ok:false, cost_usd:null` (sin costo fantasma). Test que degrada la cadena y verifica la atribución.
- **ALS y streams abortados** (ESC, ADR-0065): el decorador registra en `finally` con el usage parcial normalizado; sin usage ⇒ fila con `usage:0` y `error:"aborted"`.
- **Contaminación C0→C2**: la telemetría es puramente observacional (como `events`: never read back) — no inyecta contexto; `--bare` no cambia.
- **Colisión de nombres**: no crear colección «sessions» (auth web, ADR-0046); el forense se ancla en `runs`.

### Dependencias
- **SPEC-02 (tiering)**: origen del campo `tier` en `MeterMeta` y del fix 404 del FallbackProvider; sin SPEC-02 la traza degrada limpiamente a `tier:null` (esta spec NO se bloquea).
- **SPEC-03 (síntesis)**: el timeline enlaza el `session_summary`/slug al final; `session_timeline` es el insumo de las sesiones de síntesis; el gate «no done sin memoria» aparece como entrada del forense y puede verificarse contra `llm_calls` (¿corrió la síntesis?).
- **SPEC-06 (multiagent)**: consume `parent_run_id` y el spawn enriquecido con `child_run_id` definidos aquí para el rollup por árbol.
- **SPEC-11 (modelcat)**: consumidor aguas abajo — la deducción automática de capacidades lee `llm_calls` + `runs` (SPEC-11 depende de esta, no al revés).
- **SPEC-10 (thesis)**: toma de aquí las filas IMPL y la enmienda de `tab:metrics`/`costo_pond`. ADR-0070/AACL: sin dependencia (el canal push de AACL podría alimentar un timeline vivo; queda por referencia).
