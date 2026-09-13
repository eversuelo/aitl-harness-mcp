## SPEC-11 — Catálogo de capacidades de modelos + failover de host/modelo (`modelcat`)
**Requisitos que cubre:** 16 (principal); habilita 6 (tiering), 8 (hosts), 12 (gasto por modelo) y 17 (flag `vision` que consume SPEC-12).

### Objetivo y motivación
Hoy "el modelo" es un string plano: `MODEL_PRIMARY` en config, `run.model` en telemetría (que además guarda el nombre del *slot* — `openrouter`, o la cadena `a→b` de un FallbackProvider — no el modelo real). No existe ningún lugar donde el harness sepa qué modelo sirve para qué, cuánto cuesta, cuánta ventana tiene, ni —lo más valioso— **cómo se ha comportado de verdad en los runs de este usuario**. Esta spec crea la colección `models` (cards de capacidades), el **binding** tier/agent/rol→modelo (revive la pieza "C1: colección models + binding" — la «vinculación de modelo» por rol que el cap. 3 documenta en §roles, chapter-03/chapter.tex:447, y que quedó como capacidad sin implementar cuando Q11/H11 se removió), la **deducción automática de aptitud desde la telemetría real** (verify pass rate, stalls, tool-errors, resumes por modelo), y el **protocolo de handoff no-silencioso**: cuando un modelo u host agota tokens/cuota/contexto (429/402/overflow), el harness lo detecta, marca la card como agotada y **SUGIERE al usuario** el cambio de modelo o de host con candidatos razonados — nunca cambia un binding por su cuenta. El orquestador consulta el catálogo al asignar subagentes, de modo que tanto el harness como un host adapter (SPEC-08) puedan orquestar "bajo el modelo adecuado".

### Estado actual (anclas de código verificadas)
- `src/providers/base.ts` — `Provider.capabilities(): ProviderCapabilities` (contracts.ts:56-64: `toolUse/jsonMode/maxContext/streaming/caching/hostAdapter`) es **estático y declarado por el adapter**, sin datos empíricos ni precio. `FallbackProvider` (base.ts:251-323) salta de backend con un callback `onFallback` que solo hace `console.error` (base.ts:84-87) — el usuario no se entera ni queda evento. `providerStatus()`/`aitl models` (cli.ts:338) reportan solo *configuración*, no capacidades. BUG conocido (dueño: SPEC-02): un 404 del primario no degrada la cadena.
- `src/util/retry.ts` — `isTransientError()` ya reconoce 429/5xx/rate limit/overloaded; `withRetry` reintenta en el MISMO provider. No distingue "cuota/billing agotado" (402) ni "context overflow" (no transitorios: hoy matan el run sin sugerencia).
- `src/orchestration/graph.ts` — el `$set` final del run (graph.ts:794-813) ya persiste `model`, `token_usage`, `iters`, `tool_calls`, `gate_denials`, `stop_reason` (`completed|max_iters|verify_exhausted|stalled|budget|interrupted`), `verified`, `verify_rounds`, `stall_strikes`. Eventos `retry`, `stall`, `budget`, `verify`, `tool_call` en `events` (event.model.ts:23-40). **Toda la materia prima de la deducción ya existe** — falta atribuirla al modelo real.
- `src/orchestration/orchestrator.ts` — `orchestrate()` usa UN provider para master y todos los subagentes (líneas 71 y 96); no consulta nada.
- `src/hosts/base.ts` — `HOST_SPECS` (claude-code/codex/antigravity); `parseClaudeJson` ya extrae `meta.model`, `cost_usd`, cache breakdown (base.ts:78-99). `MODEL_HOST` reservado en config.ts:40 sin consumir (lo consume SPEC-08).
- `src/models/` — 26 modelos Mongoose; NO existe catálogo de modelos ni bindings. `definition.model.ts` ya soporta kinds `agent|skill|loop` con colección por kind — patrón a imitar, pero models/bindings van en colecciones propias (son hechos operativos, no definiciones versionadas por contenido).
- Tesis: cap. 3 roles = «lente + modo + severidad + disparadores + **una vinculación de modelo**» (chapter-03:447); Q11 removida 2026-07-12 (respuestas-preguntas-vs-hipotesis.md:222-230) dejando el diseño como capacidad del artefacto — exactamente el hueco que esta spec implementa.

### Diseño

#### Modelo de datos — `src/models/modelCard.model.ts` (colección `models`)
```ts
const modelCardSchema = new Schema({
  _id: { type: String },                    // "<slot>/<model_id>": "openrouter/qwen/qwen3-coder", "anthropic/claude-opus-4-8", "host:claude-code/sonnet"
  provider: { type: String, required: true },// slot: anthropic|openrouter|lmstudio|openai-compat|host:claude-code|host:codex|host:antigravity
  model_id: { type: String, required: true },
  display_name: String,
  best_for: { type: [String], enum: ["design", "implement", "synthesize", "orchestrate", "embed", "vision"], default: [] },
  context_window: Number, max_output: Number,
  price: { input_per_mtok: Number, output_per_mtok: Number, cache_read_per_mtok: Number, currency: { type: String, default: "USD" } },
  declared: { tool_use: Boolean, json_mode: Boolean, streaming: Boolean, caching: Boolean, vision: Boolean, resume: Boolean },
  observed: {                               // SIEMPRE recomputado por deduce — nunca editado a mano
    runs: Number, verify_pass_rate: Number, completed_rate: Number, stall_rate: Number,
    tool_error_rate: Number, avg_iters: Number, resume_ok: Number, resume_fail: Number,
    tokens_in: Number, tokens_out: Number, cost_usd: Number,
    last_run_at: Date, window_days: Number, computed_at: Date,
  },
  recall_fitness: { type: String, enum: ["fit", "degraded", "unfit", "unknown"], default: "unknown" }, // derivado de observed
  status: { type: String, enum: ["active", "deprecated", "exhausted"], default: "active" },
  exhausted_until: { type: Date, default: null },  // backoff de cuota; expira solo
  source: { type: String, enum: ["seed", "user", "deduced"], default: "seed" }, notes: String,
}, { ...BASE_SCHEMA_OPTS, collection: "models" });
```
Las cards son **globales** (los hechos de un modelo no dependen del proyecto); la *elección* sí es por proyecto → bindings.

#### Bindings — `src/models/modelBinding.model.ts` (colección `model_bindings`)
```ts
{ _id: ObjectId, project: String, kind: { enum: ["tier", "agent", "role", "loop"] },
  key: String,           // "design"|"implement"|"synthesize"|"orchestrate" para tier; nombre para agent/role/loop
  model: String,         // _id de card
  fallbacks: [String],   // cards ordenadas; la cadena del FallbackProvider se arma de aquí
  pinned: Boolean, updated_at: Date }     // índice único (project, kind, key)
```
**Precedencia de resolución** (documentada y testeada): flag CLI explícito > binding `agent`/`role` > binding `loop` (LoopSpec) > binding `tier` > env `MODEL_TIER_*` (SPEC-02) > `MODEL_PRIMARY`. SPEC-11 aporta la tabla persistida y `resolveBinding`; el router de SPEC-02 la consume.

#### Módulo nuevo `src/modelcat/`
- `catalog.ts` — `upsertModelCard(card)`, `listModels(filter?: {best_for?, fit?, active?})`, `getModelCard(id)`, `resolveBinding(project: string, kind: BindingKind, key: string): Promise<ResolvedModel>` donde `ResolvedModel = { card: ModelCard; provider: string; model_id: string; chain: ModelCard[] }` (cadena = card + fallbacks activos no-exhausted). Salta cards con `status:"exhausted"` vigente y lo reporta en `chain_skipped[]`.
- `seed.ts` — `seedModelCatalog()`: cards iniciales idempotentes (nunca pisa `source:"user"`): Anthropic (opus-4-8 → design/orchestrate, sonnet → implement, haiku → synthesize), Chutes/OpenRouter (qwen3-coder, deepseek-v3, glm-4.x, kimi-k2 → implement/synthesize con precios aprox del gateway), hosts (`host:claude-code` etc. con `declared.resume:true`). Se invoca desde `aitl init` (patrón seeds existente en initRepo).
- `deduce.ts` — el corazón del requisito «forma FÁCIL de deducir qué modelo trabajó qué»:
```ts
export interface ObservedStats { /* = shape de observed */ }
export function computeObserved(runs: RunLike[], events: EventLike[]): Map<string, ObservedStats>; // PURA, testeable sin DB
export async function deduceObserved(opts?: { windowDays?: number; project?: string }): Promise<DeduceReport>;
export function classifyFitness(o: ObservedStats): "fit" | "degraded" | "unfit" | "unknown";
```
  Reglas deterministas de `classifyFitness` (umbral publicado en docs, ajustable por env):
  `unknown` si `runs < 5`; `unfit` si `resume_fail > resume_ok` o `completed_rate < 0.3`; `degraded` si `stall_rate > 0.3` o `tool_error_rate ≥ 0.15`; `fit` en el resto con `verify_pass_rate ≥ 0.6`. La agregación cruza `runs` (por `model_ref`, ver F1) con `events` (`stall`, `retry`, `verify`, `tool_call` con `payload.error`) y resumes (runs con `harness_config.resume`). Runs previos a F1 se atribuyen por heurística slot→modelo de la época y se marcan `attribution:"legacy"` (excluibles con `--strict`).
- `handoff.ts` — protocolo de handoff:
```ts
export type ExhaustionKind = "rate_limit" | "quota_billing" | "context_overflow" | "auth" | "server_down";
export function classifyExhaustion(err: unknown): ExhaustionKind | null;
// 429/"rate limit"→rate_limit · 402/"insufficient credits|quota"→quota_billing ·
// "context length|maximum context|prompt is too long"→context_overflow · 401/403→auth · ECONNREFUSED/5xx persistente→server_down
export async function markExhausted(cardId: string, kind: ExhaustionKind): Promise<void>; // exhausted_until: rate_limit +5min, server_down +2min, quota/auth hasta que el usuario la reactive
export async function proposeHandoff(ctx: { project: string; run_id?: string; tier?: string; from: string; kind: ExhaustionKind }): Promise<HandoffProposal>;
export interface HandoffProposal { from: string; kind: ExhaustionKind; message: string;
  candidates: { model: string; reason: string; est_price?: string }[] }  // cards activas con best_for⊇tier, fitness fit>degraded, ordenadas por (fitness, precio, context_window); incluye hosts delegables (SPEC-08) si hay CLI disponible
```

#### Integración del handoff (NUNCA silencioso)
1. `FallbackProvider` gana un hook opcional `onExhausted?: (provider: string, kind: ExhaustionKind, err: unknown) => Promise<void>` invocado en `tryEach` cuando `classifyExhaustion(err) !== null`, ANTES de saltar al siguiente eslabón: marca la card (`markExhausted`), emite evento `model_exhausted` y encola la sugerencia. El salto *dentro de la cadena ya configurada* se conserva (el usuario la configuró = consentimiento previo); lo que jamás ocurre solo es cambiar un binding persistido o de host.
2. Superficie interactiva (chat/run con TTY): al agotarse el run o en la siguiente frontera de turno, prompt: `[handoff] openai-compat/deepseek-v3 agotado (rate_limit). Sugerencia: openrouter/qwen3-coder (fit, ~$0.45/M). ¿Cambiar el binding implement? [s/N/otro]` — solo con "s" se escribe el binding (y queda evento `handoff_accepted`).
3. Superficie headless (MCP `run_agent`, orchestrate, run-host): `AITL_HANDOFF=log` → nunca bloquea; la sugerencia viaja en el resultado (`suggestions[]` en `RunAgentResult`), en el evento `handoff_proposed` (visible con `aitl coord poll` / SSE de AACL por referencia) y en `aitl models --suggest`.
4. Eventos nuevos en `event.model.ts` (aditivo al enum `EVENT_TYPES`): `model_exhausted`, `handoff_proposed`, `handoff_accepted`.

#### Orquestador consulta el catálogo
En `orchestrate()` (orchestrator.ts): si `opts.provider` no viene explícito, master/plan/síntesis usan `resolveBinding(project, "tier", "orchestrate")` (fallback a `design`) y cada subagente `resolveBinding(project, "tier", "implement")`; el evento `spawn` se enriquece con `{ model, binding, fitness }`. Con SPEC-08, si el binding de un subagente apunta a una card `host:*`, el fan-out delega vía `runOnHost` en vez de `runAgent` — el catálogo es el único árbitro de "quién orquesta y quién implementa".

#### Tools MCP (patrón `server.tool` + `runLogged` + `TOOL_RBAC` + canario en rbac.test.ts; recurso RBAC nuevo `models`)
- `list_models` — `{ best_for?: z.enum([...]).optional(), fit?: z.enum([...]).optional() }` → cards con observed resumido. Read-only.
- `deduce_model_stats` — `{ window_days: z.number().int().default(30), project: z.string().optional() }` → recomputa observed+fitness, devuelve deltas. RBAC `models:update`.
- `bind_model` — `{ project: z.string(), kind: z.enum(["tier","agent","role","loop"]), key: z.string(), model: z.string(), fallbacks: z.array(z.string()).default([]) }`. RBAC `models:update`.
- `propose_handoff` — `{ project: z.string(), from: z.string(), kind: z.enum(["rate_limit","quota_billing","context_overflow","auth","server_down"]) }` → `HandoffProposal` (para que un host externo u orquestador ajeno pida la sugerencia). Read-only.

#### CLI (extiende `aitl models` existente, cli.ts:338; sigue en `NO_DB_COMMANDS` solo el modo status)
```
aitl models                       # tabla: card · slot · best_for · fitness · precio · exhausted · runs(30d)
aitl models --seed                # siembra idempotente del catálogo
aitl models --deduce [--window 30] [--strict]   # recomputa observed desde la telemetría real
aitl models --suggest             # sugerencias de handoff pendientes (handoff_proposed sin aceptar)
aitl models bind tier:implement openrouter/qwen/qwen3-coder --fallback openai-compat/deepseek-v3
aitl models bind role:security anthropic/claude-opus-4-8
aitl models show <cardId>         # card completa + observed + últimos runs atribuidos
```
Config/env: `AITL_HANDOFF=ask|log` (default `ask` con TTY, `log` sin TTY), `AITL_MODELCAT_WINDOW_DAYS=30`, `AITL_FITNESS_MIN_RUNS=5`. Los `MODEL_TIER_*` de SPEC-02 aceptan ids de card (`slot/model`).

#### Seed inicial de referencia (editable; precios aprox al día del seed, `source:"seed"`)
| Card | best_for | ctx | precio in/out $/Mtok | declared |
|---|---|---|---|---|
| `anthropic/claude-opus-4-8` | design, orchestrate | 200k | 5.00 / 25.00 | tools+json+stream+cache+resume |
| `anthropic/claude-sonnet-4-x` | implement, orchestrate | 200k | 1.00 / 5.00 | tools+json+stream+cache+resume |
| `anthropic/claude-haiku-4-x` | synthesize | 200k | 0.25 / 1.25 | tools+json+stream+cache |
| `openai-compat/deepseek-v3` (Chutes) | implement, synthesize | 128k | ~0.25 / ~0.85 | tools+json+stream |
| `openrouter/qwen/qwen3-coder` | implement | 256k | ~0.30 / ~1.20 | tools+json+stream |
| `openrouter/moonshotai/kimi-k2` | design, implement | 128k | ~0.50 / ~2.00 | tools+json |
| `host:claude-code/default` | orchestrate, implement | n/a | medido por run | resume (session_id) |
| `host:codex/default` | implement | n/a | n/a | — |

#### Flujo end-to-end (ejemplo concreto)
1. `aitl orchestrate "migra los tests a node:test" --project aitl-js` → master resuelve `tier:orchestrate` → `anthropic/claude-opus-4-8`; 3 subagentes resuelven `tier:implement` → `openai-compat/deepseek-v3` con fallback `openrouter/qwen/qwen3-coder` (cadena del binding → FallbackProvider).
2. Al 2º subagente Chutes responde `402 insufficient credits` → `classifyExhaustion` = `quota_billing` → `markExhausted("openai-compat/deepseek-v3", "quota_billing")` (sin TTL: queda exhausted hasta reactivación) + evento `model_exhausted` → la cadena degrada a qwen3-coder y el run TERMINA bien.
3. Al cierre, el resultado incluye `suggestions[]` y el CLI imprime:
```
[handoff] openai-compat/deepseek-v3 agotado (quota_billing) durante 2 subagentes.
  Sugerencia 1: openrouter/qwen/qwen3-coder  (fit, verify 0.71 en 12 runs, ~$0.30/M)
  Sugerencia 2: host:claude-code/default     (fit, resume nativo, costo medido)
  Fijar: aitl models bind tier:implement openrouter/qwen/qwen3-coder
```
4. El usuario decide; si acepta se escribe el binding + evento `handoff_accepted`. Nada cambió sin su OK.
5. Días después, `aitl models --deduce` recalcula: deepseek sigue `exhausted`, qwen sube a 19 runs con verify 0.74 → `fit` consolidado; el catálogo aprende de la telemetría, no de opiniones.

Ejemplo de salida de `propose_handoff` (la consume también un orquestador externo vía MCP):
```json
{ "from": "openai-compat/deepseek-v3", "kind": "quota_billing",
  "candidates": [
    { "model": "openrouter/qwen/qwen3-coder", "reason": "fit (verify 0.71, 12 runs), best_for implement, ~$0.30/M" },
    { "model": "host:claude-code/default", "reason": "fit, resume nativo, CLI disponible" } ],
  "message": "openai-compat/deepseek-v3 sin créditos; se sugiere cambiar el binding tier:implement." }
```

### Fases de implementación
- **F1 — Colección + seed + atribución real**: `modelCard.model.ts`, `modelBinding.model.ts`, `catalog.ts`, `seed.ts`; estampar `model_ref` (id de card) en el run doc: en `runAgent` desde el provider resuelto y en `run-host` desde `meta.model` de `parseClaudeJson`; `aitl models`/`--seed`/`show`. Verifica: `npm run verify` verde; E2E: `aitl models --seed && aitl models` lista cards; `aitl run "di hola" --project aitl-js` y `aitl run-show <id>` muestra `model_ref`.
- **F2 — Deducción**: `deduce.ts` con `computeObserved` PURO + tests unitarios de las reglas (runs/events sintéticos: caso fit, degraded por stalls, unfit por resume_fail, unknown por n<5, atribución legacy); CLI `--deduce`; tool `deduce_model_stats` + RBAC + canario. Verifica: `node --test src/modelcat/deduce.test.ts`; E2E vivo contra Atlas con los runs históricos del proyecto (`aitl models --deduce --window 90` imprime deltas plausibles).
- **F3 — Binding + orquestador**: `resolveBinding` + precedencia (test dedicado), `bind_model` tool + `aitl models bind`, `orchestrate()` consultando catálogo + evento `spawn` enriquecido. Verifica: test de precedencia flags>agent>tier>env; E2E `aitl orchestrate` con bindings distintos para orchestrate/implement y eventos con `model`.
- **F4 — Handoff**: `handoff.ts` (`classifyExhaustion` con tests de mensajes reales 429/402/"prompt is too long"), hook `onExhausted` en `FallbackProvider`, eventos nuevos, prompt interactivo en chat/run, `suggestions[]` en `RunAgentResult`, `--suggest`, tool `propose_handoff`. Verifica: test unit de clasificación; E2E con provider fake que lanza 429 (patrón `AITL_HOST_CMD_*` fake de council) → evento `model_exhausted` + `handoff_proposed` y prompt visible; headless nunca bloquea.
- **F5 — Superficie + docs**: columna fitness/model_ref en la pestaña web Runs + vista mínima Models; `docs/MODELS-CATALOG.md` (umbrales de fitness, precedencia, protocolo de handoff, recetas). Verifica: `npm run build:web`; verify verde final.

### ADRs a registrar
- «Catálogo de capacidades de modelos: colección `models` con aptitud deducida de telemetría» — proposed.
- «Binding tier/agent/rol→modelo persistido y precedencia de resolución» — proposed.
- «Protocolo de handoff no-silencioso ante agotamiento de modelo u host» — proposed.

### Medición para la tesis
Doble papel. (a) **Instrumento**: `verify_pass_rate`/`stall_rate`/`tool_error_rate` por modelo son exactamente las métricas por-modelo que pide el requisito 12 y alimentan `tab:metrics` vía SPEC-09; `recall_fitness` convierte la selección de modelos de la campaña confirmatoria (n≥3, cap. 5) en un criterio reproducible y citable en vez de elección a ojo; la celda `c2-tiered` (SPEC-10) usa los bindings como definición operacional de la condición. (b) **Cierre de diseño**: implementa la «vinculación de modelo» de roles del cap. 3 (:447) como capacidad sin compromiso evaluativo (precedente Q11), con nota en la bitácora IMPL. No introduce celda experimental propia.

### Riesgos y mitigaciones
- `run.model` histórico ambiguo (nombre de slot o cadena `a→b`) → deducción confiable solo desde F1 (`model_ref`); lo viejo entra marcado `legacy` y `--strict` lo excluye.
- Muestras chicas → `unknown` bajo `AITL_FITNESS_MIN_RUNS`; la deducción **jamás** cambia un binding sola: solo clasifica y sugiere.
- Falsos positivos de agotamiento (un tool output que contiene "429") → `classifyExhaustion` se aplica SOLO a errores de la capa provider (withRetry/FallbackProvider), nunca a resultados de tools.
- Prompt de handoff colgando runs headless → `AITL_HANDOFF=log` automático sin TTY; el prompt solo existe en chat/run interactivos.
- Precios desactualizados → `price` editable (`source:"user"` gana al seed); el costo real medido es de SPEC-09 (esta colección es su catálogo de precios).
- Cards globales vs multiproyecto → hechos globales, elección por proyecto (bindings); si dos proyectos disputan una card, solo difieren en bindings.

### Dependencias
- **SPEC-02** (`tiering`): consume `resolveBinding`; dueño del fix 404-degrada del FallbackProvider y de `MODEL_TIER_*`/`aitl models --check`. SPEC-11 aporta la tabla; SPEC-02 el router.
- **SPEC-08** (`hosts`): cards `host:*`, consumo de `MODEL_HOST`, delegación de subagentes a hosts — el handoff "cambia de host" requiere sus adapters.
- **SPEC-09** (`telemetry`): comparte la colección `models` como catálogo de precios; `model_ref` es la clave de atribución del cost report y del forense de sesión.
- **SPEC-12** (`multimodal`): lee `declared.vision` para elegir VLM.
- ADR-0070 / AACL: no requeridos; los eventos de handoff viajarán por el push SSE de AACL cuando exista (por referencia).
