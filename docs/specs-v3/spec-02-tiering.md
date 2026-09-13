## SPEC-02 — Tiering de modelos design/implement/synthesize + router + Chutes/OpenRouter + fix fallback 404
**Requisitos que cubre:** 6 (principal: tiering con Chutes/OpenRouter) y 15 (embeddings: auditoría E2E + slot remoto); habilita 5 (síntesis con modelo barato) y 12 (atribución de gasto por tier/modelo, consumida por SPEC-09)

### Objetivo y motivación

Hoy el harness resuelve UN provider por proceso: `getProvider()` sin argumento cae en `MODEL_PRIMARY` (`src/providers/base.ts:71-78`) y ese mismo backend planifica en `orchestrate()` (`src/orchestration/orchestrator.ts:71`), ejecuta cada subagente (`orchestrator.ts:94-105`), corre el loop (`src/orchestration/graph.ts:186`) y resume la sesión (`graph.ts:769` → `summarizeSession`). Resultado: o se paga modelo caro para resumir transcripts, o se planifica con un 7B. El requisito 6 pide división explícita: **el mejor LLM diseña, el intermedio implementa, el barato sintetiza** — que además es lo que la tesis promete en cap. 5 §division. Esta spec introduce tres tiers nombrados (`design`/`implement`/`synthesize`) mapeados a los slots existentes, cablea cada punto de consumo al tier correcto, cierra el bug del 404 (memoria `provider-chutes-404-en-synthesize`: cadena de un solo provider + Synthesizer sin catch ⇒ el error se propaga en vez de degradar al extractivo), añade health-check de slots (`aitl models --check`), inexistente hoy (`aitl models` solo lee env, `src/cli.ts:347-375`), y resuelve la duda del requisito 15: auditoría E2E de los embeddings locales + slot remoto de embeddings con migración coherente de dims.

### Estado actual (anclas de código verificadas)

- **Slots**: `anthropic` | `openrouter` | `lmstudio` | `openai-compat` (Chutes, `OPENAI_COMPAT_BASE_URL=https://llm.chutes.ai/v1`, `.env.example:58-60`, `docs/PROVIDERS.md`). Resolución en `getProvider(which?)` (`base.ts:71-157`); `"auto"` = cadena de fallback (`getProviderWithFallback`, `base.ts:342-352`).
- **Config**: `modelPrimary/Secondary/Host` en `src/config.ts:38-40` (env en :102-104); `ENV_KEYS` con `MODEL_PRIMARY/SECONDARY/HOST` en `src/config/store.ts:46-48`. `MODEL_HOST` reservado sin consumir (SPEC-08). No existe `MODEL_TIER_*`.
- **FallbackProvider** (`base.ts:251-323`): `tryEach` sí avanza al siguiente backend ante error (:263-275), PERO (a) `getProviderWithFallback` devuelve el provider pelado cuando `chain.length === 1` (:351) — con solo Chutes configurado un 404 no tiene a dónde degradar; (b) no hay memoria de fallos: cada `complete()` del map-reduce re-paga el 404; (c) `isTransientError` (`src/util/retry.ts:10-29`) no incluye 404 (correcto: no reintentar), pero nadie clasifica "error de config" para degradación terminal.
- **Synthesizer** (`src/memory/synthesizer.ts:196-215`): `summarize()` solo cae al extractivo ante respuesta VACÍA; una excepción de `llm.complete()` se propaga y rompe la tool `synthesize` (contradice el "nunca-en-blanco" de ADR-0059). Ídem `summarizeTranscript` (`src/memory/lifecycle.ts:340-347`; ramo determinista en :348-352).
- **Tool MCP `synthesize`** (`src/mcpserver/server.ts:1507-1557`): enum `provider` = `auto|anthropic|openrouter|lmstudio|openai-compat|extractive` (:1512-1514); el try/catch solo cubre la CONSTRUCCIÓN de la cadena (:1526-1532), no la síntesis.
- **Modelo por provider fijo en settings**: `OpenAIProvider` recibe `model` en el ctor (privado, `src/providers/openai.ts:119,131`); no hay override por invocación ni forma de que un mismo slot Chutes sirva dos modelos distintos.
- **Telemetría**: `runs.model` guarda `provider.name` (p.ej. `"openai-compat"` o `"anthropic→openrouter"`), nunca el model id; `harness_config` es `Mixed` y el schema `strict:false` (`src/models/run.model.ts:42 y 52`) — extensible sin migración. `EVENT_TYPES` en `src/models/event.model.ts:23-58`.
- **Gotcha razonadores**: `openai.ts:158-166` — un modelo razonador puede quemar todo `max_tokens` en `reasoning_content` y devolver vacío; criterio duro para elegir el tier synthesize.
- **Embeddings**: `src/ingest/embedder.ts` — `LocalEmbedder` Transformers.js `Xenova/all-MiniLM-L6-v2` (:21-49, `dims=0` hasta el primer embed), `VoyageEmbedder` HTTP (:52-69), `getEmbedder()` singleton por `EMBEDDING_PROVIDER=local|voyage` (:73-83). Config en `config.ts:66-69` (`embeddingDims` default 384) y `store.ts:63-66`. Índice Atlas: `VECTOR_COLLECTIONS=["messages","memory","decisions"]` (`src/db/indexes.ts:17`), `vectorIndexModel` name `vector_index`, coseno, `numDimensions` desde settings (:98-112, usado en :120). Consumidores: hydrate (`lifecycle.ts:58`), `aitl search` (`cli.ts:169`), skill-router (`src/projectctx/router.ts:49`), re-embed en sync/síntesis (`sync/sync.ts:114`, `synthesizer.ts:100`, `lifecycle.ts:394`). La cascada vector→text→recencia ya degrada si el vector falla. Evidencia preliminar de que SÍ funciona: `search_memory` (server.ts:374) devuelve scores 0.65-0.67, típicos de `$vectorSearch` coseno (`src/memory/store.ts:120-141`) — pero nunca se auditó E2E.

### Diseño

#### D1. Módulo `src/providers/tiers.ts` (nuevo)

```ts
export type ModelTier = "design" | "implement" | "synthesize";

/** Spec textual de un binding: "<slot>" | "<slot>:<modelId>" | "auto".
 *  El PRIMER ':' separa slot y modelo (los ids de OpenRouter/Chutes usan '/'). */
export interface TierBinding { tier: ModelTier; slot: string; model?: string; source: "env" | "default"; }

export function parseTierSpec(raw: string): { slot: string; model?: string };
/** Binding efectivo con defaults 100% compatibles hacia atrás:
 *  design    → MODEL_TIER_DESIGN    || modelPrimary
 *  implement → MODEL_TIER_IMPLEMENT || modelSecondary (si difiere de primary) || modelPrimary
 *  synthesize→ MODEL_TIER_SYNTHESIZE|| modelSecondary || modelPrimary          */
export function resolveTierBinding(tier: ModelTier): TierBinding;
/** Provider del tier: binding primero, resto de la cadena auto como fallback.
 *  Con binding.model, construye el provider con ese override (D2). */
export async function getTierProvider(tier: ModelTier, opts?: { noFallback?: boolean }): Promise<Provider>;
/** Para telemetría y status line (SPEC-04/09). */
export function tierStatus(): { tier: ModelTier; slot: string; model: string; configured: boolean; source: string }[];
```

`getTierProvider` construye `FallbackProvider([bindingProvider, ...cadenaAutoRestante])` reutilizando `providerStatus().fallbacks` (`base.ts:232`), de modo que un tier caído degrada a los demás backends configurados en vez de romper el run. Sin ningún `MODEL_TIER_*` definido, los tres tiers resuelven exactamente lo que hoy resuelve `getProvider()` — cero cambio de conducta.

#### D2. Override de modelo por invocación (extensión mínima de `getProvider`)

Firma extendida backward-compatible en `base.ts`: `getProvider(which?: string, opts?: { model?: string })`. El override se pasa al ctor del provider (`OpenAIProvider`/`AnthropicProvider` ya lo aceptan como opción); así **un solo slot Chutes sirve modelos distintos por tier** (`openai-compat:deepseek-ai/DeepSeek-V3-0324` para implement y `openai-compat:unsloth/Llama-3.3-70B-Instruct` para synthesize), levantando la limitación "un solo slot compat" de `docs/PROVIDERS.md`. Además: propiedad pública `readonly model: string` en ambos providers (hoy privada en `openai.ts:119`) y `describe(): { provider: string; model: string }` opcional en la interfaz `Provider` — `FallbackProvider` delega al primer eslabón. Es la base de la atribución por modelo de SPEC-09.

#### D3. Cableado de consumidores (parametrizar, no bifurcar)

| Punto | Ancla | Tier |
|---|---|---|
| `planSubtasks` + composición final del orquestador | `orchestrator.ts:50-61, 71, 130` | `design` |
| `runAgent` de cada subagente (`subAgentOpts.provider` si el caller no lo fija) | `orchestrator.ts:94-105` | `implement` |
| `runAgent` directo (`aitl run`, `run_agent` MCP): nuevo `RunAgentOpts.tier?: ModelTier` | `graph.ts:36-114,186` | el pedido (default: hoy) |
| `summarizeSession` al cierre del run | `graph.ts:769` | `synthesize` (best-effort; si falla, provider del run) |
| `capture-session` | `src/context/capture.ts:387-391` | `synthesize` |
| `Synthesizer` / tool MCP `synthesize` | `server.ts:1519-1539` | enum extendido: `+ design\|implement\|synthesize`; default pasa de `"auto"` a `"synthesize"` (equivalente cuando no hay tiers configurados) |
| Council `makeCouncilClient` (`"provider[:...]"`) | `src/council/adapters.ts:379-384` | acepta `"tier:design"` etc. |
| LoopSpec: campo opcional `tier` (flags > spec > defaults, ADR-0062) | `src/orchestration/loopspec.ts` | por spec — se coordina con SPEC-01 |

Estampado de telemetría: `harness_config.tier` y `harness_config.model_id` (vía `describe()`) en el run doc al crearlo (`makeRun`, `graph.ts:312-323` y `orchestrator.ts:76`); `runs.model` NO cambia de semántica. Cada evento `spawn` del orquestador añade `{ tier: "implement" }` a su payload.

#### D4. Config / env

- `SettingsSchema` (`src/config.ts`): `modelTierDesign/Implement/Synthesize: z.string().default("")`; mapeo en `loadSettings()` (:102 y ss.).
- `ENV_KEYS` (`store.ts:42`): `+ MODEL_TIER_DESIGN, MODEL_TIER_IMPLEMENT, MODEL_TIER_SYNTHESIZE` (aparecen solos en wizard/Config web, que iteran ENV_KEYS — ADR-0061). Ninguna es secreta.
- `.env.example` y `docs/PROVIDERS.md`: sección "Tiers" con la receta de abajo.

```bash
# Receta A — calidad arriba, gasto abajo (Anthropic + Chutes):
MODEL_TIER_DESIGN=anthropic                                   # ANTHROPIC_MODEL=claude-opus-4-8
MODEL_TIER_IMPLEMENT=openai-compat:deepseek-ai/DeepSeek-V3-0324
MODEL_TIER_SYNTHESIZE=openai-compat:unsloth/Llama-3.3-70B-Instruct
# Receta B — todo por OpenRouter (una sola API key):
MODEL_TIER_DESIGN=openrouter:anthropic/claude-sonnet-4.6
MODEL_TIER_IMPLEMENT=openrouter:qwen/qwen3-coder
MODEL_TIER_SYNTHESIZE=openrouter:meta-llama/llama-3.3-70b-instruct
```

#### D5. Sugerencias concretas de modelos (precios ≈ 2026-07, verificar con `--check` / páginas de pricing)

| Tier | Criterio de elección | OpenRouter (in/out por Mtok) | Chutes (`llm.chutes.ai/v1`) | Anthropic directo |
|---|---|---|---|---|
| `design` | máximo razonamiento; JSON schema para `decomposeTasks`/council; contexto ≥128k | `anthropic/claude-sonnet-4.6` (~$3/$15) · `deepseek/deepseek-r1` (~$0.5/$2.2) | `deepseek-ai/DeepSeek-R1` · `Qwen/Qwen3-235B-A22B` | `claude-opus-4-8` ($5/$25, con caching nativo) |
| `implement` | tool-calling FIABLE (bloquea: el loop vive de `tool_calls`); precio medio; contexto largo | `qwen/qwen3-coder` (~$0.3/$1.2) · `moonshotai/kimi-k2` (~$0.55/$2.2) · `deepseek/deepseek-chat-v3` (~$0.27/$1.1) | `Qwen/Qwen3-Coder-480B-A35B-Instruct` · `zai-org/GLM-4.5-Air` | `claude-sonnet-4-6` ($3/$15) |
| `synthesize` | solo `complete()` (no necesita tools); input barato (transcripts largos); **NO razonador** (quema `max_tokens` en thinking, `openai.ts:158-166`) | `meta-llama/llama-3.3-70b-instruct` (~$0.04/$0.12) · `google/gemini-2.5-flash` (~$0.3/$2.5) | `unsloth/Llama-3.3-70B-Instruct` · `Qwen/Qwen3-30B-A3B` (Chutes: cuota por suscripción, costo marginal ≈$0) | `claude-haiku-4-5` ($1/$5) |

Regla práctica documentada en `docs/PROVIDERS.md`: Chutes conviene como synthesize/implement (suscripción de cuota fija = costo marginal ~0, ideal para la síntesis obligatoria de SPEC-03); OpenRouter como design/agregador (un solo `sk-or-*`, ids namespaced); Anthropic directo cuando importa el caching (ventana 98% cacheada del caso raytracer).

#### D6. Fix fallback 404 (degradar, no propagar) — 3 capas

1. **Clasificación** — nuevo `src/providers/errors.ts`: `classifyProviderError(err): "transient" | "config" | "unknown"`. `config` = `/\b(400|401|403|404|422)\b/` o `model_not_found|invalid model|no body`; `transient` reutiliza `isTransientError` (`retry.ts:10-29`). Exportada y testeada pura.
2. **FallbackProvider con cuarentena** (`base.ts:251-323`): ante error clase `config`, el backend se marca en un `Map<string, number>` (`quarantinedUntil`, TTL `AITL_PROVIDER_QUARANTINE_MS`, default 300 000) y `tryEach`/`chatStream` lo SALTAN mientras dure — el map-reduce de síntesis deja de pagar N × 404. `onFallback` gana cuarto parámetro `kind: "transient" | "config"`. Con cadena de UN eslabón el error sigue subiendo (correcto): la degradación terminal es del caller ↓.
3. **Degradación terminal en callers con fallback determinista**:
   - `Synthesizer.summarize` (`synthesizer.ts:196-215`): `try/catch` alrededor de cada `llm.complete`; ante error → `extractive()` para esa categoría + `degraded: { category, error }` en el report + warning en el evento `synthesis`. El "nunca-en-blanco" de ADR-0059 pasa a cubrir también excepciones.
   - `summarizeTranscript` (`lifecycle.ts:340-347`): `try/catch` → cae al ramo determinista ya existente (:348-352).
   - Tool MCP `synthesize` (`server.ts:1520-1554`): el resultado reporta `synthesizer: "model:X (degraded: 404 …)"` cuando hubo degradación — visible para el host que llamó.

#### D7. Health-check — `aitl models --check` y tool MCP

Nuevo `src/providers/health.ts`:

```ts
export interface SlotHealth { slot: string; model: string; ok: boolean; latency_ms: number;
  checked: "list_models" | "complete"; error?: string; model_listed?: boolean; }
export async function checkSlots(opts?: { timeoutMs?: number }): Promise<SlotHealth[]>;   // slots configurados
export async function checkTiers(): Promise<(SlotHealth & { tier: ModelTier })[]>;        // los 3 bindings
```

Sonda barata sin gastar tokens: `GET {baseURL}/models` en slots OpenAI-compat (Chutes/OpenRouter/LM Studio lo sirven) verificando que el model id configurado APARECE en la lista (`model_listed`) — detecta exactamente el bug de la memoria (modelo `default` inexistente en Chutes); Anthropic vía `client.models.list()` del SDK. Si el endpoint `/models` no existe (410/404 del endpoint mismo), fallback a `complete("ping", { maxTokens: 1 })`. CLI: `aitl models --check [--json]` — tabla `slot/tier · modelo · ok · latencia · error`, exit code 1 si algún slot configurado falla; se documenta como paso 1 del "How to apply" de la memoria del bug. Tool MCP read-only `provider_health` (sin entrada en `TOOL_RBAC`, `server.ts:241-277`, por no mutar; igualmente envuelta en `runLogged`) para que un host remoto diagnostique. Con `--record`, evento tipo `provider_health` (añadir a `EVENT_TYPES`, `event.model.ts:23-58`) para la pestaña web y SPEC-09.

#### D8. Flujo E2E de referencia (receta A configurada)

```
aitl orchestrate "añade fog exponencial al path tracer" --project aitl-raytracer
  1. resolveTierBinding(design)    → anthropic / claude-opus-4-8      → planSubtasks()      [3 subtareas]
  2. resolveTierBinding(implement) → openai-compat / DeepSeek-V3-0324 → 3 × runAgent(...)   [tools, paralelo]
     · run doc de cada subagente: harness_config = { tier: "implement", model_id: "deepseek-ai/DeepSeek-V3-0324", ... }
  3. composición final             → design                            → provider.complete(synthInput)
  4. resolveTierBinding(synthesize)→ openai-compat / Llama-3.3-70B    → summarizeSession()  [memoria durable]
     · si Chutes responde 404: cuarentena del slot + FallbackProvider prueba anthropic;
       si TODA la cadena falla → summarizeTranscript degrada al ramo determinista y el run cierra igual.
aitl models --check   # antes de la campaña: valida los 3 bindings contra /models (model_listed=true)
```

#### D9. Embeddings (requisito 15): auditoría E2E, slot remoto y migración de dims

**Veredicto propuesto: (b) mantener + respaldar, no remover.** La evidencia (scores 0.65-0.67 de `$vectorSearch`) indica que el pipeline local FUNCIONA; lo que falta es prueba sistemática y una salida si el entorno no puede correr Transformers.js. La remoción rompería hydrate/search/router sin necesidad — la cascada vector→text→recencia ya es el fallback limpio.

1. **Auditoría E2E** — nuevo `src/ingest/embeddingAudit.ts` + CLI `aitl embeddings audit [--json]`:
   ```ts
   export interface EmbeddingAudit {
     provider: string; model: string; declared_dims: number;
     probe: { ok: boolean; dims: number; latency_ms: number; error?: string };     // embedOne("ping")
     index: { collection: string; exists: boolean; num_dimensions: number | null }[]; // Search index API, vs vectorIndexModel (indexes.ts:98-112)
     coverage: { collection: string; total: number; with_embedding: number; dims_mismatch: number }[]; // countDocuments + $exists/$size
     self_query: { collection: string; ok: boolean; top_score: number | null }[];  // embed del texto de un doc real → $vectorSearch → ¿score ≥0.99 y top-1 = el mismo doc?
     verdict: "healthy" | "degraded" | "broken";
   }
   export async function auditEmbeddings(project?: string): Promise<EmbeddingAudit>;
   ```
   `self_query` es la prueba reina: cierra la duda "¿el índice Atlas tiene los vectores y los usa?" con un experimento reproducible por colección de `VECTOR_COLLECTIONS`. Exit code 1 si `verdict !== "healthy"`. También expuesto como sección de `aitl models --check` (los embeddings SON un slot de modelo más).
2. **Slot remoto** — `EMBEDDING_PROVIDER` pasa de `z.enum(["local","voyage"])` (`config.ts:66`) a `z.enum(["local","voyage","openai-compat"])`, con nuevas env `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` (secreta, entra a `SECRET_KEYS`, `store.ts:86-96`) sumadas a `ENV_KEYS`. Nueva clase en `embedder.ts` siguiendo el patrón exacto de `VoyageEmbedder` (:52-69):
   ```ts
   export class OpenAICompatEmbedder implements Embedder {
     constructor(private baseUrl: string, private modelName: string, private apiKey: string, public dims: number) {}
     async embed(texts: string[]): Promise<number[][]>; // POST {baseUrl}/embeddings {input, model} → data[].embedding + guard de dims
   }
   ```
   Recetas documentadas: Chutes sirve `/v1/embeddings` para modelos de embeddings alojados (p.ej. `EMBEDDING_BASE_URL=https://llm.chutes.ai/v1`, `EMBEDDING_MODEL=BAAI/bge-m3`, 1024 dims — verificar id con la sonda); **caveat honesto en docs**: OpenRouter NO expone endpoint de embeddings hoy — el slot es OpenAI-compat genérico (OpenAI, Ollama, vLLM, Chutes) y cubrirá OpenRouter el día que lo sirva. El guard de dims lanza error accionable si `data[0].embedding.length !== EMBEDDING_DIMS` (hoy un mismatch solo revienta en el `$vectorSearch`).
3. **Migración de dims** — CLI `aitl embeddings migrate --provider <p> --model <m> --dims <n> [--dry-run] [--yes]`: (i) sonda al proveedor nuevo y verifica dims; (ii) `--dry-run` reporta docs a re-embeder y estimación de costo/tokens; (iii) re-embed batched por cursor de las 3 `VECTOR_COLLECTIONS` escribiendo `embedding` vía `$set`; (iv) al final — y solo al final — drop + recreate de `vector_index` con `numDimensions` nuevas (reusa `ensureVectorIndexes`, `indexes.ts:114-131`) y espejo de `EMBEDDING_*` a config/`.env` (patrón `--detect`, `cli.ts:397-407`); (v) evento `embedding_migrate` con stats. Mientras migra, la cascada vector→text→recencia mantiene hydrate/search operativos (degradan a `$text`) — sin downtime duro. Requiere `--yes` o confirmación TTY (operación que re-paga N embeddings).

### Fases de implementación

- **F1 — Errores + fallback robusto**: `src/providers/errors.ts`, cuarentena en `FallbackProvider`, degradación terminal en `Synthesizer`/`summarizeTranscript`/tool `synthesize`. Verifica: unit tests con providers fake que lanzan `404 status code (no body)` (cadena avanza, cuarentena salta al segundo intento, síntesis degrada a extractivo con `degraded` en el report); `npm run verify` verde; E2E: `OPENAI_COMPAT_MODEL=no-existe aitl run "di hola" --project aitl-js` degrada sin stack trace.
- **F2 — Router de tiers**: `src/providers/tiers.ts` + `getProvider(which, { model })` + `readonly model`/`describe()` + config/env (`MODEL_TIER_*` en schema, store, `.env.example`). Verifica: tests de `parseTierSpec` (slot solo, `slot:model`, model con `/`, `auto`), de defaults (sin env ⇒ binding idéntico a `getProvider()`), de fallback de tier a cadena auto; typecheck.
- **F3 — Cableado**: orquestador (design/implement), `RunAgentOpts.tier`, `summarizeSession`/capture a synthesize, enum de la tool `synthesize`, estampado `harness_config.{tier,model_id}`, CLI `aitl run --tier <t>` y `aitl orchestrate` con tiers automáticos. Verifica: test del orquestador con providers fake distintos por tier afirmando qué provider recibió `planSubtasks` vs subagentes vs summarize; `aitl run "toca un archivo" --tier implement` estampa `harness_config.tier="implement"` en el run doc (`aitl run-show`).
- **F4 — Health-check**: `src/providers/health.ts`, `aitl models --check`, tool `provider_health`, evento `provider_health`, tabla de tiers en `aitl models` (sin flags). Verifica: unit con fetch mockeado (200 con modelo listado / 200 sin el modelo / ECONNREFUSED); E2E vivo contra Chutes con la key real: `aitl models --check` reporta el estado del slot; canario RBAC sigue verde (tool read-only fuera de `TOOL_RBAC`).
- **F5 — Embeddings**: `embeddingAudit.ts` + `aitl embeddings audit`, `OpenAICompatEmbedder` + env nuevas, `aitl embeddings migrate` con `--dry-run`. Verifica: unit de `OpenAICompatEmbedder` (fetch mock: happy path, dims mismatch, 401) y del plan de migración (orden re-embed→índice); E2E vivo: `aitl embeddings audit --json` contra el Atlas real DEBE salir `healthy` con self_query ≥0.99 (ese JSON es el veredicto del requisito 15 y se guarda como memoria); round-trip de migración en la BD `atlas-local` de docker-compose (384→1024→384).
- **F6 — Docs + guía**: `docs/PROVIDERS.md` §Tiers (tabla D5 + recetas + criterio Chutes-vs-OpenRouter) y §Embeddings (slot remoto + caveat OpenRouter), `.env.example`, `docs/GUIA-CLI.md` (`--tier`, `--check`, `embeddings audit|migrate`), actualización de `docs/ARQUITECTURA.md`. Verifica: `npm run verify`; `aitl sync --project aitl-js` limpio; lectura cruzada de recetas contra `aitl models --check`.

### ADRs a registrar

- «Tiering de modelos design/implement/synthesize: router sobre los slots de provider existentes» — status: proposed → accepted al cerrar F3 (decisión: tiers como parametrización de `getProvider`, no providers nuevos; defaults backward-compatible; naming de la V3).
- «FallbackProvider: clasificación de errores, cuarentena por config-error y degradación terminal a extractivo» — accepted en F1 (cierra la deuda de la memoria `provider-chutes-404-en-synthesize`; consecuencia: un 404 ya no rompe síntesis pero puede ocultar mala config ⇒ mitigado con `aitl models --check` y el warning `degraded`).
- «Embeddings: veredicto de auditoría E2E, slot remoto OpenAI-compat y migración de dims del índice» — proposed en F5, accepted con el JSON del audit como evidencia (decisión: mantener local como default, NO remover; consecuencia/deuda: dos fuentes de dims (env + índice) reconciliadas solo por el audit y el guard).

### Medición para la tesis

- **Condición nueva `c2-tiered`** en `tab:cond` (cap. 4): harness completo + `MODEL_TIER_*` poblados (design=API frontier, implement=medio, synthesize=barato) vs `c2` monolítica — mismas fases F0-F5 del raytracer, tope 60 min. Materializa la celda exploratoria `c2-sonnet-spec` que cap. 5 §division deja diseñada.
- **Métrica nueva** en `tab:metrics`: `costo_pond` desglosado **por tier** (posible por `harness_config.tier` + `model_id` de D3; el catálogo de precios y el reporte son de SPEC-09) + tasa de degradación (`degraded`/síntesis totales). Pregunta medible: ¿la división de trabajo reduce costo_pond sin bajar fases completadas?
- **Embeddings**: capacidad sin compromiso evaluativo — es instrumentación interna del artefacto, no condición experimental; PERO el JSON de `aitl embeddings audit` entra al cap. 4 como evidencia de que el canal de recuperación semántica del harness opera (sustenta la validez de las celdas c2, que dependen de hydrate).
- Archivos transversales: fila IMPL en la bitácora, `tab:cond`/`tab:metrics`, THESIS-STATE.md, respuestas-preguntas-vs-hipotesis.md (H sobre proceso>modelo). El detalle editorial lo consolida SPEC-10.

### Riesgos y mitigaciones

- **Precios/ids de terceros caducan** (OpenRouter/Chutes rotan catálogo): la tabla D5 se marca "≈, verificar"; `--check` valida `model_listed` en runtime; los precios canónicos viven en la colección editable de SPEC-09, no hardcodeados.
- **Tier implement con tool-calling débil** rompe el loop silenciosamente: documentar el criterio "tool-calling fiable" como BLOQUEANTE en D5; el stall detector (`stall.ts`) ya corta runs sin progreso; smoke-test recomendado `aitl run "lee package.json y di la versión" --tier implement`.
- **Cuarentena oculta mala config permanente**: el warning `onFallback(kind:"config")` se loggea SIEMPRE y `aitl models`/status line (SPEC-04) muestran el slot en cuarentena; TTL corto (5 min) por defecto.
- **Doble gasto por fallback de tier** (tier barato cae a slot caro): `getTierProvider(tier, { noFallback: true })` disponible para presupuestos duros; la síntesis prefiere degradar a extractivo antes que encadenar hacia un slot caro (orden de cadena documentado).
- **Enum cambiado en tool `synthesize` rompe hosts viejos**: solo se AÑADEN valores; `"auto"` conserva semántica; canario en `mcpserver` con los valores viejos.
- **Migración de embeddings a medias** (proceso muerto entre re-embed e índice): el orden re-embed→índice deja en el peor caso vectores nuevos con índice viejo ⇒ `$vectorSearch` falla y la cascada degrada a `$text`; re-correr `migrate` es idempotente (re-embede solo `dims_mismatch`); el audit detecta el estado y lo nombra `degraded`.
- **Entorno sin Transformers.js** (la duda original del usuario): `optionalImport` ya lanza error accionable; con el slot remoto el fallback es un cambio de 3 env vars, no una reescritura.

### Dependencias

- **SPEC-01 `loops`**: el campo `tier` de LoopSpec lo define esta spec (D3) pero lo versiona/documenta SPEC-01; coordinar el hash de contenido.
- **SPEC-03 `sintesis`**: consumidor principal de `getTierProvider("synthesize")` y del contrato "degradar, nunca romper" (su gate determinista de cierre depende de que la síntesis no lance).
- **SPEC-09 `telemetry`**: consume `harness_config.{tier,model_id}`, `describe()` y los eventos `provider_health`/`embedding_migrate`; dueña del catálogo de precios (aquí solo se estampan ids).
- **SPEC-11 `modelcat`**: la colección `models` refina los bindings de D1 (tier→modelo por catálogo + handoff); esta spec entrega el router que SPEC-11 consulta — sin dependencia inversa.
- **SPEC-04 `cli`**: status line lee `tierStatus()`. **SPEC-06/08**: subagentes en worktrees/hosts heredan `implement` por `subAgentOpts`; `MODEL_HOST` sigue intacto para SPEC-08. **SPEC-12 `multimodal`**: reutiliza D2 (override de modelo) para elegir VLM por invocación.
- ADR-0070 (repomap) y AACL: sin dependencia.
