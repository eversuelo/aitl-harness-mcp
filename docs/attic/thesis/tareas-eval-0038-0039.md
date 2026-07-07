# AITL-Harness-JS — Tareas de Evaluación · ADR 0038–0039

> **Addendum** al backlog del Ciclo 01 (`docs/backlog-ciclo-01.md`).
> EVAL-1 instrumenta y *hace visible* la contabilidad de tokens. EVAL-2 introduce el acotamiento
> condicional vía HeadRoom **en rama aparte**, como variable de evaluación. Juntas habilitan el
> experimento *con/sin compresión* de tu tesis.

---

## Nota de numeración ADR (reconciliación)

- El Ciclo 01 ocupa **0024–0037** (C1=0024 … E8=0037), ya reconciliado contra la colección `decisions` de Atlas.
- Siguientes libres: **0038, 0039**.
  - **EVAL-1 → ADR-0038**
  - **EVAL-2 → ADR-0039** — *esta ADR absorbe* la decisión de adopción de HeadRoom (dependencia vs. metodología) que se discutió antes. **No se crean dos ADRs sobre HeadRoom**; la estratégica y la de implementación son la misma 0039.
- **Regla de proceso (registrar):** el número de ADR se reconcilia contra Atlas (`decisions`), nunca contra `CLAUDE.md`. Los ADRs se escriben en la fase BUILD de su tarea, no al planear.

---

## Aclaración de arquitectura (antes de implementar)

Pediste "una **habilidad** tipo HeadRoom". Dos precisiones para no meterla en el subsistema equivocado:

1. **No es un `skill` del DefinitionStore.** Esos son *instrucciones para el modelo* (texto inyectado). Lo de HeadRoom es una **capacidad de pipeline** que transforma el contexto antes de llegar al modelo. Va detrás de un **port**, no en la colección `skills`.
2. **Modelarla como port refuerza tu tesis.** Es el *mismo patrón* que tu `Provider` port (agnosticismo de modelo): un port `ContextCompressor` con dos adapters (`Native` / `Headroom`) hace del acotamiento una propiedad **estructural y conmutable**, no un `if` disperso. EVAL-2 te da agnosticismo de *compresión* por construcción.

---

# EVAL-1 · Instrumentación de tokens + trazabilidad de contexto + UI de análisis  🎓 · M/L · ADR-0038

**Objetivo.** Contabilizar tokens (ground-truth del proveedor), descomponer el uso de contexto, medir rescatabilidad y trazabilidad, y **exponer todo como una vista de análisis en el UI**. Sin sistema paralelo: se enriquecen los eventos que ya emites + dos tipos nuevos.

**Por qué.** "Uso, rescatabilidad y trazabilidad" son las **variables dependientes** de tus experimentos DSR. Sin medirlas, la evaluación no es defendible. Y hacerlas *visibles* convierte la economía de tokens en evidencia legible para la defensa.

**Depende de.** C1 (`models` con `cost`), C2 (actor), C4 (traza + `task`), E-roles (atribución por rol).

## Contrato

### Cuatro fronteras de captura (ni una más)

| Frontera | Captura | Reusa |
|---|---|---|
| `Provider.chat` | `usage` real del proveedor | Provider port |
| `hydrate` | tokens por segmento + su fuente | evento `hydrate` (ya emite desglose) |
| `ContextManager.compact/clearToolResults` | qué se comprimió y cuánto | ContextManager |
| `headroom_retrieve` / re-expansión | qué se rescató | tool MCP (EVAL-2) |

### Colección dedicada `token_usage` (grado billing)

```ts
export const TokenUsageSchema = z.object({
  runId: z.string(), taskId: z.string().optional(),
  project: z.string(), actorId: z.string(),
  roleName: z.string().optional(), model: z.string(),   // ref models.id (C1)
  promptTokens: z.number().int(), completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  source: z.enum(["measured", "counted", "estimated"]), // honestidad metodológica
  costUsd: z.number(), ts: z.string(),
});
```

- **Costo** = `prompt/1e6 · model.cost.inputPerMTok + completion/1e6 · model.cost.outputPerMTok`.
- **`source`**: `measured` = `usage` del proveedor; `counted` = `countTokens` cuando el host no expone usage (claude-code/codex/antigravity); `estimated` = `estimateTokens` (solo pre-llamada, nunca contabilidad).

### Tipos de evento nuevos (a la colección `events`)

```ts
export const ContextAssembledSchema = z.object({
  runId: z.string(), iter: z.number().int(), model: z.string(),
  windowLimit: z.number().int(), totalInput: z.number().int(),
  utilizationPct: z.number(),
  segments: z.object({                       // tokens por segmento
    persona: z.number(), memory: z.number(), decisions: z.number(),
    conventions: z.number(), repomap: z.number(),
    history: z.number(), toolOutputs: z.number(),
  }),
  sources: z.array(z.object({                // procedencia → trazabilidad
    segment: z.string(), ref: z.string(),    // "memory:slug" | "adr:0024" | "tool:callId"
    tokens: z.number(),
  })),
});

export const CompressionEventSchema = z.object({
  runId: z.string(), iter: z.number().int(),
  target: z.enum(["tool_output", "history", "file", "rag"]),
  tokensBefore: z.number(), tokensAfter: z.number(), ratio: z.number(),
  reversible: z.boolean(), ttlSec: z.number().optional(),
  originalRef: z.string().optional(), engine: z.enum(["native", "headroom"]),
});

export const RetrievalEventSchema = z.object({
  runId: z.string(), iter: z.number().int(),
  originalRef: z.string(), tokensRestored: z.number(),
  hit: z.boolean(), latencyMs: z.number(),   // hit=false → ya fuera del TTL
});
```

### Trazabilidad pre/post compresión (cierra la grieta)

Cada paso registra `tokensBefore` / `tokensAfter` / `ratio`. La traza distingue **lo que el harness ensambló** de **lo que el modelo recibió**. Sin esto tu claim de trazabilidad tiene un hueco justo donde la compresión actúa.

### Tools MCP (extiende C4)

| Tool | Devuelve |
|---|---|
| `get_token_usage(filter)` | uso/costo agregado por run/actor/rol/modelo/proyecto/task |
| `get_context_breakdown(runId)` | composición + fuentes de un run |
| `get_recoverability(runId\|taskId)` | compresiones, rescates, tasa, fracción recuperable |

---

## UI de análisis — vista **"Context & Cost Analytics"**

Hermana de la UI de traza (E7). Reusa `server/api.ts` (ya proyecta `MemoryStore`) + endpoints sobre `token_usage`/`events`. Gráficas con Recharts/Chart.js.

### Cómo funciona el análisis (pipeline)

```txt
events + token_usage        →   Mongo aggregation        →   API / MCP tools       →   React
(crudo, append-only)            ($match→$group→$bucket)       (get_token_usage…)        (paneles)
```

El análisis **no calcula nada nuevo de tokens**: agrega los números ya contabilizados. Cada panel es una proyección de campos concretos del esquema de contabilidad. Toda cifra hereda su `source` (`measured`/`counted`/`estimated`) y el UI la **etiqueta con su confianza** — igual que HeadRoom rotula *measured* vs *estimated*.

### Paneles (qué muestra · de dónde se computa · qué insight)

| Panel | Qué muestra | Se computa de | Insight |
|---|---|---|---|
| **Overview (KPIs)** | costo total, tokens in/out, #runs, costo/run | `$group` sum sobre `token_usage` | gasto global, por tenant (Schoolar) |
| **Spend breakdown** (barras/treemap) | costo por rol / modelo / actor | `$group` por dimensión, sum `costUsd` | quién y qué consume |
| **Window burn-down** (área apilada por iter) | tokens por segmento a lo largo de las iteraciones + línea `windowLimit` | `ContextAssembled.segments` por `iter`; `utilizationPct` | *ves llenarse la ventana y qué la llena* — el panel didáctico clave |
| **Provenance flow** (sankey) | segmento → `ref` fuente → tokens | `ContextAssembled.sources` | de dónde vino el contexto (trazabilidad) |
| **Compression & recoverability** (combo) | distribución de `ratio` · tasa de rescate · fracción recuperable decayendo por TTL · costo evitado | `CompressionEvent` + `RetrievalEvent` | ¿comprimiste de más? ¿es reversible de verdad? |
| **Context precision** (gauge) | segmentos inyectados vs usados → % ruido | `ContextAssembled.sources` cruzado con citas/tool calls posteriores al mismo `ref` | ¿`hydrate` mete ruido? (aproximado, etiquetado) |
| **Run drill-down** | un run → su traza (E7) + estos paneles acotados al run | join por `runId` | une economía y procedencia |

### Catálogo de métricas (cada una mapeada a su fuente)

| Métrica | Fórmula | Evento fuente |
|---|---|---|
| Costo por run/tarea | Σ(prompt·in + completion·out) | `token_usage` + `models.cost` |
| Tokens por actor/rol/modelo | agregación | `token_usage` |
| Utilización de ventana | `totalInput / windowLimit` | `ContextAssembled` |
| Composición de contexto | `segmento / totalInput` | `ContextAssembled` |
| Ratio de compresión | `after / before` | `CompressionEvent` |
| Tasa de rescate | `retrievals / compressions` | `Retrieval` + `Compression` |
| Fracción recuperable | `still_recoverable / compressed` | `Compression` + TTL |
| Precisión de contexto | `usados / inyectados` | `ContextAssembled` + atribución |
| Costo evitado por compresión | `(before − after) · in_price` | `Compression` + `models.cost` |

> La última métrica es la del experimento *con/sin compresión* (EVAL-2).

## Skill global incluida — `adr-ledger-reconcile`

> **Por qué vive en 0038:** esta ADR instrumenta y *mide* la memoria y las decisiones. Una traza de
> contexto montada sobre un ledger de ADRs con huecos o referencias de memoria stale está construida
> sobre arena. Esta skill **garantiza la integridad del ledger y de la memoria que 0038 mide**: es la
> guardiana de los datos *antes* de analizarlos.

Skill **global** (aplica a todos los proyectos) que reordena/reconcilia el ledger de ADRs y su
memoria. Definición completa en `adr-ledger-reconcile/SKILL.md`. En una frase: lee la fuente de
verdad (`decisions` en Atlas vía `list_decisions`), detecta huecos/duplicados/punteros stale/
huérfanos, produce un plan `old→new` **antes** de mutar, reconcilia las referencias en `memory`,
corrige `CLAUDE.md`/docs y verifica que no se escribió ningún ADR por accidente. **Nunca registra un
ADR** (eso es BUILD). Codifica el procedimiento manual con que reconciliamos el Ciclo 01.

**Dependencia de scope global:** `routeSkills`/`hydrate` deben incluir un scope reservado `__global__`
además del proyecto activo. Es la vía mínima para skills globales antes del agrupamiento completo (E6).

> Nota de reviewer: por responsabilidad única, esta skill **podría** ser su propia ADR (0040). La
> incluyo en 0038 como pediste, bajo el encuadre "integridad de la memoria medida"; si después
> quieres extraerla, es un corte limpio.

## Aceptación

- [ ] `token_usage` creada con índices; `COLLECTIONS`/`init-db` la cubren.
- [ ] Toda llamada a modelo registra `usage` con `source` correcto y `costUsd` derivado de `models.cost`.
- [ ] `hydrate` emite `ContextAssembled` con `segments` + `sources` + `utilizationPct`.
- [ ] Compresión/rescate emiten sus eventos con `tokensBefore/After/ratio` y `engine`.
- [ ] `get_token_usage`, `get_context_breakdown`, `get_recoverability` operativas por MCP.
- [ ] Vista "Context & Cost Analytics" renderiza los 7 paneles con datos reales de una task de Schoolar.
- [ ] Cada cifra del UI muestra su etiqueta `measured/counted/estimated`.
- [ ] Skill `adr-ledger-reconcile` registrada en scope `__global__`; `routeSkills`/`hydrate` la consideran en cualquier proyecto.
- [ ] Una corrida de reconciliación es reproducible, produce el reporte (estado/issues/plan/verificación) y **no escribe ningún ADR**.

**ADR.** `ADR-0038 — Instrumentación de tokens, contabilidad de costo y trazabilidad de contexto, e integridad del ledger de ADRs vía skill global `adr-ledger-reconcile` (medición e integridad de la memoria como artefacto de evaluación)`.

**Diseño (DSR).** *Adjuntar `source` (measured/counted/estimated) a cada cifra y registrar tokens pre/post por paso convierte la contabilidad en un instrumento de evaluación auditable, no en telemetría decorativa; es decisión de metodología de medición.*

---

# EVAL-2 · Capacidad de acotamiento de contexto condicional a HeadRoom (rama aparte)  🟡 · M · ADR-0039

**Objetivo.** Una capacidad de acotamiento de contexto que **se activa solo si HeadRoom está activo**; si no, hace fallback transparente a la compresión nativa. Se desarrolla y evalúa en **rama separada** (`eval/headroom-context-bounding`).

**Por qué.** Es la **variable independiente** del experimento de compresión de tu tesis, y aísla una dependencia externa detrás de un port (sin contaminar el harness ni diluir la contribución).

**Depende de.** EVAL-1 (sin su instrumentación no hay con qué medir el efecto), C1 (`models.cost` para "costo evitado").

## Contrato

### Port `ContextCompressor` (hexagonal, como tu Provider)

```ts
export interface ContextCompressor {
  compress(chunk: ContextChunk, opts: CompressOpts): Promise<CompressResult>; // emite CompressionEvent
  retrieve(ref: string): Promise<string | null>;                              // emite RetrievalEvent
  capabilities(): { reversible: boolean; engine: "native" | "headroom" };
}
```

- `NativeCompressor` → envuelve tu `ContextManager.compact/clearToolResults` (no reversible, `engine:"native"`). **Default siempre disponible.**
- `HeadroomCompressor` → enruta contenido voluminoso (`tool_output`/`file`/`rag`) por HeadRoom; reversible vía CCR (`engine:"headroom"`).

### Detección de "HeadRoom activo" (gate)

| Estrategia | Cómo | Recom. |
|---|---|---|
| Health-check de proxy | `GET HEADROOM_PROXY_URL/health` al boot | **Sí** — desacoplado, coherente con proxy-first |
| Resolución de lib | `require.resolve("headroom-ai")` | parcial (el grueso es Python/Rust) |
| Flag explícito | `HEADROOM_ENABLED=1` | override manual para la rama de eval |

**Selección:** un resolver elige `HeadroomCompressor` si el gate pasa; si no, `NativeCompressor`. **Mismo code path on/off** → es lo que hace limpio el A/B.

### Reversibilidad

Exponer `headroom_retrieve` al modelo vía tu `ToolRegistry`. Sin esa tool, la compresión es con pérdida y el agente no recupera el original exacto (p. ej. la línea precisa de un stack trace).

### No doble-comprimir

Si `HeadroomCompressor` está activo, **desactivar** la compresión nativa sobre el mismo target (evitar aplastar dos veces, corromper `estimateTokens` y desincronizar la traza). El port garantiza un solo motor por target.

## Diseño experimental (en la rama)

- **A (control):** `NativeCompressor`. **B (tratamiento):** `HeadroomCompressor`.
- Mismo conjunto de tareas sobre Schoolar; mismas seeds de modelo (C1).
- Métricas (de EVAL-1): **costo evitado**, **ratio**, **tasa de rescate**, **paridad de calidad** de la respuesta.
- Honestidad: holdout (`HEADROOM_OUTPUT_HOLDOUT`) + reportar ahorro con intervalo de confianza, no número inventado.
- Pin de versión de HeadRoom + `kompress-base` en el camino medido (reproducibilidad).

## Aceptación

- [ ] Port `ContextCompressor` con ambos adapters; `capabilities()` correcto.
- [ ] Gate de detección funciona; con HeadRoom **apagado**, el harness corre idéntico vía `NativeCompressor` (no-op de la ruta HeadRoom).
- [ ] Con HeadRoom **encendido**, contenido voluminoso pasa por HeadRoom y emite `CompressionEvent engine:"headroom"`.
- [ ] `headroom_retrieve` disponible al modelo; rescates emiten `RetrievalEvent`.
- [ ] Sin doble compresión sobre un mismo target.
- [ ] Corre en `eval/headroom-context-bounding`; el A/B produce las métricas de EVAL-1.

**ADR.** `ADR-0039 — Acotamiento de contexto condicional vía HeadRoom: dependencia tras un port, gate de detección y registro de ratio (dependencia vs. metodología propia)`.

**Diseño (DSR).** *Aislar la compresión externa tras un port con detección de capacidad permite tratar al proveedor de compresión como variable experimental sin acoplar el harness; el agnosticismo de compresión es el mismo patrón que el de modelo.*

---

## Apéndice — cómo se conectan EVAL-1 y EVAL-2

- **EVAL-1 mide siempre** (HeadRoom on u off): es la regla del experimento.
- **EVAL-2 introduce la variable** (motor de compresión) en rama.
- Juntas = el experimento *con/sin compresión*, con cifras etiquetadas por confianza. Sin EVAL-1, EVAL-2 es invisible; sin EVAL-2, EVAL-1 mide solo el motor nativo.
