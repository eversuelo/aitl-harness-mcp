## SPEC-01 — Motor de agentic loops declarativos (LoopStrategy)
**Requisitos que cubre:** 2 (principal: motor + guía + config fácil); habilita 12 (trazabilidad `loop_spec@version`+`strategy` por run) y da los enganches a 8 (orchestrator-workers como fachada del fan-out) y a 6 (tier por fase de estrategia, vía SPEC-02).

### Objetivo y motivación
El cap. 3 de la tesis diseña `LoopStrategy` como Strategy sobre Template Method con seis ids (`retry|react|reflexion|plan-execute|evaluator-optimizer|orchestrator-workers`) — y nunca se implementó. A la vez, la IMPL consolidó un **bucle único** `runAgent` (retiro de LangGraph, ADR-0047) con loop engineering versionado (ADR-0062). La tensión se resuelve con una regla de diseño dura: **una estrategia NO es una subclase del loop, es una COMPILACIÓN a política** — cada id se traduce a una combinación de perillas que `runAgent` ya tiene (verifiers, reflect, maxVerifyRounds, budgets, stall) más tres capacidades aditivas pequeñas (turno de plan, memoria episódica de lecciones, verifier-LLM). `orchestrator-workers` compone el `orchestrate()` existente (que ya es "un runAgent por subtask"), así que el core sigue siendo uno. El resultado: loops declarativos en `.aitl/loops/*.md|yaml` versionados por content-hash, un grupo CLI `aitl loop`, la guía `docs/LOOPS.md` y exposición MCP — elegir el regulador por tarea (Ashby) pasa a ser editar un archivo de 10 líneas, y cada run declara exactamente qué diseño de bucle lo produjo.

### Estado actual (anclas de código verificadas)
- **Loop**: `src/orchestration/graph.ts` — `RunAgentOpts` (l.36-114, incl. `loopSpec` l.109), `runAgent(prompt, project, opts)` (l.181), resolución spec→policy (l.190-211), ensamblaje de `verifiers` + `spec.verifyCmd` (l.216-236), `reflect()` turno sin tools tras verify fallido (l.462-487), ronda de verify con ventana fresca (l.617-641), presupuesto con turno de cierre (l.503-540), stall (l.730-754). Stop reasons `completed|max_iters|verify_exhausted|stalled|budget|interrupted` (l.129-135).
- **LoopSpec (ADR-0062)**: `src/orchestration/loopspec.ts` — `LoopSpecSchema` zod `.strict()` SIN noción de estrategia (l.18-40), `LOOP_DEFAULTS` (l.45-50), `loopSpecVersion` content-hash sha256[:12] (l.53-56), `isSpecPath` solo JSON (l.65-67), `loadLoopSpecAuto` nombre→solo colección (l.79-87), `saveLoopSpec` (l.102-115), `resolveLoopPolicy` flags > spec > defaults (l.138-153).
- **La colección `loops` YA existe**: `src/models/definition.model.ts` — `DefinitionKind = "agent" | "skill" | "loop"` (l.26), `LOOPS_COLLECTION` (l.25), `modelFor`→`LoopModel` (l.62-63); `DefinitionStore` (`src/projectctx/store.ts:21-27`) ya sirve el kind. PERO `registerDefinitionTools` solo se invoca para `"agent"`/`"skill"` (`src/mcpserver/server.ts:997-998`) — no hay CRUD MCP de loops — y `aitl sync` solo espeja memory/skills/agents (`src/sync/sync.ts:4`, planes en l.500-501) — no hay espejo `.aitl/loops/`.
- **CLI**: `aitl run --loop-spec` existe (`src/cli.ts:188`, overrides l.260-281); **NO existe grupo `aitl loop`** (verificado en el índice de `command(...)`). Chat REPL con slash commands (`src/repl/chat.ts`, ayuda l.94+, dispatch l.264+).
- **MCP**: tool `run_agent` (`src/mcpserver/server.ts:1223-1287`) acepta `loop_spec` (l.1230) pero no estrategia; `TOOL_RBAC` (l.241-277) + canario `mcpserver/rbac.test.ts`.
- **Subagentes**: `src/orchestration/orchestrator.ts` — `orchestrate()` (l.66), `planSubtasks` (l.50), `subAgentOpts` reenviados a cada `runAgent` (l.29, l.104), ToolRegistry fresco por subagente (l.103).
- **Tesis**: `sections/chapter-03/chapter.tex` — §"Patrones de bucle como Strategy" (l.816), bloque verbatim del contrato `LoopStrategy` con `step/isDone/shouldEscalate` (l.836-845); l.53 la tabla de puertos ya define LoopStrategy como `run(prompt, project, opts)`.
- **Infra que se reutiliza**: `harness_config` es `Schema.Types.Mixed` (`src/models/run.model.ts:42`) — estampar campos nuevos no exige migración; `gray-matter@^4.0.3` ya es dependencia (`package.json:82`) — parsear front-matter/YAML no requiere dep nueva; `EVENT_TYPES` es enum CERRADO (`src/models/event.model.ts:23-57`) — todo evento nuevo debe añadirse ahí.

### Diseño

#### 1. Principio: estrategia = compilación a política (Strategy sin bifurcar el Template Method)
El contrato del cap. 3 se mapea honesto sobre el esqueleto real: `step()` ES el cuerpo de `runAgent` (único); `isDone()` ES la terminación por verifiers; `shouldEscalate()` ES el circuit breaker existente (stall/budget/verify_exhausted) más un escalamiento opcional a humano. Lo único que varía por estrategia es **la política resuelta y hasta 3 capacidades aditivas**. Módulo nuevo `src/orchestration/strategies.ts`:

```ts
export type StrategyId = "retry" | "react" | "reflexion" | "plan-execute"
                       | "evaluator-optimizer" | "orchestrator-workers";
/** Compila una estrategia a defaults de política + capacidades. PURA (testeable sin IO). */
export function strategyToPolicy(id: StrategyId, spec: LoopSpec): StrategyCompiled;
export interface StrategyCompiled {
  policyDefaults: LoopPolicyOverrides;          // se insertan ENTRE spec y LOOP_DEFAULTS
  plan?: boolean;                                // turno de plan pre-loop (plan-execute)
  lessons?: { inject: number; write: boolean };  // memoria episódica (reflexion)
  evaluator?: { rubric: string; rounds: number };// verifier-LLM (evaluator-optimizer)
  workers?: { max: number; budgetMsEach: number };// fan-out (orchestrator-workers)
}
/** Fachada estrategia-consciente: 5 estrategias → runAgent parametrizado;
 *  orchestrator-workers → orchestrate() con subAgentOpts compilados. */
export async function runLoop(prompt: string, project: string,
  opts: RunAgentOpts & { strategy?: StrategyId }): Promise<RunAgentResult>;
```
Tabla de compilación (defaults por estrategia; TODO overridable por spec o flags):

| id | compila a |
|---|---|
| `retry` | `maxIters: 3`, `maxVerifyRounds: 5`, `reflect: false` — cada verify fallido ES el retry; para tareas atómicas con `verifyCmd` |
| `react` | identidad: `LOOP_DEFAULTS` (el loop actual YA es ReAct — se declara explícito, no se duplica) |
| `reflexion` | `reflect: true` + `lessons: {inject: 3, write: true}` — memoria episódica de fallos |
| `plan-execute` | `plan: true`, `maxIters: 16` — turno de plan sin tools, plan fijado al system |
| `evaluator-optimizer` | `evaluator` obligatorio en el spec; `maxVerifyRounds` = rondas de optimización (default 4), `reflect: true` |
| `orchestrator-workers` | delega en `orchestrate()`; `workers.max` (default 4, mapea a `maxSubagents`), presupuesto POR worker obligatorio (default `budgets.ms: 600_000` c/u) |

Precedencia final (extiende `resolveLoopPolicy`, firma retro-compatible con 4º arg opcional `strategyDefaults`): **flags explícitos > campos del spec > defaults de la estrategia > `LOOP_DEFAULTS`**.

#### 2. Extensión de `LoopSpecSchema` (aditiva, sigue `.strict()`)
En `src/orchestration/loopspec.ts`:
```ts
strategy: z.enum(["retry","react","reflexion","plan-execute",
                  "evaluator-optimizer","orchestrator-workers"]).optional(),
/** Guía operativa del loop: se inyecta al system prompt (clamp 4000 chars al inyectar). */
instructions: z.string().max(20_000).optional(),
plan: z.boolean().optional(),
lessons: z.object({ inject: z.number().int().min(0).max(10).default(3),
                    write: z.boolean().default(true) }).optional(),
evaluator: z.object({ rubric: z.string().min(1),
                      rounds: z.number().int().min(1).max(10).default(4),
                      tier: z.enum(["design","implement","synthesize"]).optional() }).optional(),
workers: z.object({ max: z.number().int().min(1).max(8).default(4),
                    budgetMsEach: z.number().int().positive().default(600_000) }).optional(),
escalate: z.object({ onStallStrikes: z.number().int().min(1).optional(),
                     onVerifyRounds: z.number().int().min(1).optional(),
                     action: z.enum(["ask","stop"]).default("stop") }).optional(),
/** Reservado para SPEC-05 (perfiles de toolset por modelo). */
toolset: z.string().optional(),
```
`loopSpecVersion` no cambia (hash sobre el spec canónico ⇒ toda extensión versiona sola). `harness_config` del run estampa además `strategy` e `instructions_hash` cuando aplican (Mixed: sin migración).

#### 3. Cambios aditivos en `runAgent` (graph.ts) — tres capacidades, cero bifurcación
- **Turno de plan** (`policy.plan`): antes del `for` principal (tras construir `system`, ~l.398), UN turno `provider.chat` SIN tools con prompt "produce un plan numerado y verificable; no uses tools"; user+assistant se persisten atómicos con `idx` coherente (resume intacto) y el plan se añade al `system` como bloque `## Committed plan`. Evento nuevo `strategy_phase {phase:"plan"}`.
- **Lecciones (reflexion)**: en la ruta de verify fallido (l.617-641), si `policy.lessons.write`, escribir memoria tipo `lesson` (slug `lesson-<runId8>-r<n>`, contenido = feedback del verifier + diagnóstico del turno reflect, `tags:["lesson", strategy]`, best-effort vía `MemoryStore`; `lesson` entra a `RESERVED_MEMORY_TYPES` en `src/memory/schemas.ts:37` para que la clasificación no lo pise). Al INICIO del run, si `lessons.inject > 0` y no `--bare`, recuperar las N lecciones más relevantes del project (cascada vector→text→recencia existente) y anexarlas al preámbulo. Evento `strategy_phase {phase:"lesson", slug}`.
- **Verifier-LLM (evaluator)**: factoría `llmVerifier(rubric, provider): Verifier` en `strategies.ts` — `provider.complete()` con rúbrica + `finalText`, salida JSON `{pass: boolean, feedback: string}` (usa `CompleteOpts.jsonSchema`, ya soportado, con parseo tolerante de fallback); se registra en el array `verifiers` existente (l.216-217), heredando eventos `verify`, rondas frescas y `reflect` sin tocar el loop. El provider del evaluador se resuelve por `evaluator.tier` cuando exista SPEC-02; mientras, `getProvider("secondary")`.
- **Escalamiento** (`policy.escalate` = `shouldEscalate` del contrato): en los puntos donde hoy se aborta (stall l.748, verify_exhausted l.625-628), si el umbral configurado se alcanza y `action:"ask"` con TTY, preguntar al humano (reutiliza el prompt de `hooks/approval.ts`): `continuar | abortar | instruir <texto>`; "instruir" anexa un turno user y refresca la ventana. Evento `escalation {trigger, decision, ms}` (su `ms` suma a `supervision_minutes`, H11).
- **Eventos**: `strategy_phase` y `escalation` se AÑADEN al enum `EVENT_TYPES` (`src/models/event.model.ts:23-57`) — cambio aditivo al array `as const`.

#### 4. Config declarativa: `.aitl/loops/*.md|yaml|json` + espejo sync (sin deps nuevas)
- **Loaders nuevos** en `loopspec.ts`: `loadLoopSpecMarkdown(path)` — front-matter YAML = campos del spec, cuerpo markdown = `instructions` — y `loadLoopSpecYaml(path)`; ambos parsean con `gray-matter` YA vendorado (`package.json:82`; el `.yaml` puro se envuelve como front-matter `---\n…\n---` para reusar el mismo engine: **cero dependencias nuevas**). `loadLoopSpecAuto` extiende su resolución: (1) path-like → por extensión `.json|.yaml|.yml|.md`; (2) nombre → `.aitl/loops/<name>.{md,yaml,json}` buscando `.aitl/` hacia arriba (reutiliza el walk de `src/projectctx/resolveProject.ts`); (3) colección `loops`. El content-hash es el MISMO `loopSpecVersion` sobre el spec parseado ⇒ archivo y store con igual contenido dan igual versión.
- **Espejo `aitl sync`**: `src/sync/sync.ts` añade `buildDefinitionPlan("loop", ...)` junto a skill/agent (l.500-501) con serialización md front-matter+cuerpo ⇒ `loops` ⇄ `.aitl/loops/<name>.md`, mismo manifiesto de dos hashes y conflictos exit 2.
- **Ejemplo completo** (`.aitl/loops/raytracer-f3.md`):
```markdown
---
name: raytracer-f3
strategy: plan-execute
maxIters: 20
budgets: { tokens: 120000, ms: 2700000 }
verifyCmd: "bash check.sh 3"
stallThreshold: 2
escalate: { onVerifyRounds: 3, action: ask }
---
Trabaja fase por fase del plan. Tras cada edición corre el check ANTES de seguir.
Nunca reescribas un archivo completo si un edit puntual basta.
```

#### 5. CLI `aitl loop {list,show,init,run,lint}` (`src/cli.ts`, grupo nuevo)
- `aitl loop list --project <p>`: vista fusionada store + `.aitl/loops/` — columnas `name@version  strategy  source(file|store)  desc`.
- `aitl loop show <nameOrPath> [--task "<t>"] [flags de run]`: spec parseado + **política EFECTIVA** (dry-run de `resolveLoopPolicy` con los flags dados) + hash — responde "¿qué correría exactamente?".
- `aitl loop init <name> [--strategy react]`: scaffold `.aitl/loops/<name>.md` desde plantilla comentada de la estrategia (la "forma fácil"); `--save` lo sube al store (`saveLoopSpec`).
- `aitl loop run <name> "<task>" --project <p> [flags]`: azúcar de `aitl run --loop-spec <name>` ruteado por `runLoop`. `aitl run` gana además `--strategy <id>` (override puntual sin spec).
- `aitl loop lint [dir]`: valida todos los specs de `.aitl/loops/` contra el schema (exit 1 con detalle zod) — apto para CI.
- Chat: slash `/loop <name|off>` en `src/repl/chat.ts` fija el loopSpec de los turnos siguientes (listado en `/help`, l.94+).

#### 6. Exposición MCP (+5 tools CRUD + estrategia en run_agent, RBAC, canario)
- `registerDefinitionTools("loop")` en `server.ts` (junto a l.997-998) ⇒ `write_loop/get_loop/list_loops/search_loops/delete_loop`; `registerDefinitionTools` gana un parámetro opcional `validate?: (content: string) => void` que para `"loop"` hace `LoopSpecSchema.parse(JSON.parse(content))` antes del upsert — un spec inválido nunca entra al store.
- `TOOL_RBAC` (l.241-277): `write_loop: { resource: "agents_skills", action: "create" }`, `delete_loop: { resource: "agents_skills", action: "delete" }` + actualización del canario en `mcpserver/rbac.test.ts` (27→29 mutantes).
- `run_agent` (l.1223+) gana `strategy: z.enum([...]).optional()` y su handler llama `runLoop` en vez de `runAgent` (misma forma de retorno; retro-compatible).

#### 7. Guía `docs/LOOPS.md` (español, enlazada desde README y GUIA-CLI)
Secciones: (1) anatomía del loop — los 5 elementos obligatorios del cap. 3 mapeados a perillas reales; (2) las 6 estrategias: tabla cuándo-usar-cuál + qué compila cada una; (3) formato del spec md/yaml/json + precedencia flags>spec>estrategia>defaults; (4) recetas: celda C2 de la tesis, `raytracer-f3` con `check.sh`, `retry` para tareas atómicas; (5) lectura de resultados (`stop_reason`, `verified`, `verify_rounds`, eventos `strategy_phase`); (6) troubleshooting (stalled, verify_exhausted, presupuesto). `aitl init` siembra `.aitl/loops/react.md` y `plan-execute.md` de ejemplo (idempotente, patrón [ok|skip] de `initRepo.ts`).

### Fases de implementación
- **F1 — Compilador de estrategias (puro)**: extensión de `LoopSpecSchema`, `STRATEGY_DEFAULTS`, `strategyToPolicy`, `resolveLoopPolicy` con 4º nivel de precedencia. Entregable: `src/orchestration/strategies.ts` + tests unitarios (compilación de las 6, precedencia con overrides, `react`≡identidad, hash estable ante campos nuevos ausentes) en `strategies.test.ts` + `loopspec.test.ts` ampliado. Verifica: `npm run verify` verde (~445 → +~15 casos).
- **F2 — Capacidades en runAgent**: turno de plan, lecciones (+`lesson` en RESERVED_MEMORY_TYPES), `llmVerifier`, escalamiento, eventos `strategy_phase`/`escalation` en `EVENT_TYPES`, estampado `strategy` en `harness_config`. Verifica: tests con provider fake (estilo `stall.test.ts`) que aserten el orden de turnos del plan, la escritura/inyección de lecciones y que `--bare` las exime; E2E vivo `aitl run "arregla X" --project aitl-js --strategy reflexion --verify-cmd 'node --test …'` y `aitl run-show` mostrando los eventos.
- **F3 — Config fácil + CLI**: loaders md/yaml con gray-matter, resolución `.aitl/loops/`, espejo en `aitl sync`, grupo `aitl loop`, `/loop` en chat. Verifica: `aitl loop init demo --strategy plan-execute && aitl loop lint && aitl loop show demo` (hash idéntico file↔store tras `--save`); `aitl sync --project aitl-js` ida y vuelta sin conflictos.
- **F4 — MCP + orchestrator-workers**: `registerDefinitionTools("loop")` con validate, RBAC + canario, `strategy` en `run_agent`, `runLoop` despachando a `orchestrate()` con `subAgentOpts` compilados (presupuesto por worker). Verifica: `rbac.test.ts` verde con el conteo nuevo; llamada MCP viva `run_agent {strategy:"retry", verify_cmd:"true"}` → `stop_reason=completed`.
- **F5 — Guía + siembra + cierre**: `docs/LOOPS.md`, plantillas en `aitl init`, memoria de sesión + ADRs + `aitl sync --pull`. Verifica: revisión de la guía contra `aitl loop show` real; `npm run verify` final.

### ADRs a registrar
- «Estrategias de loop declarativas: el contrato LoopStrategy del cap. 3 como compilación a política sobre el bucle único runAgent» — proposed al diseñar, accepted al cerrar F2 (deuda explícita: evaluator sin tier real hasta SPEC-02; escalamiento "ask" solo en TTY).
- «Specs de loop como archivos `.aitl/loops/*.md|yaml` con front-matter gray-matter, espejo `aitl sync` y CRUD MCP con validación de schema» — proposed (consecuencia: tercera fuente file/store/inline unificada por content-hash; sin dependencia nueva).

### Medición para la tesis
- **Condición nueva medible**: la estrategia entra como factor en `tab:cond` — p.ej. celdas `c2-react` (control, = hoy) vs `c2-plan-execute` y `c2-reflexion` sobre la MISMA fase del raytracer con `check.sh` como verifier; `loop_spec@version` + `strategy` en `harness_config` hacen cada corrida atribuible sin ambigüedad (cierre natural del diseño ADR-0062).
- **Métricas** (para `tab:metrics`, detalle en SPEC-10): distribución de `stop_reason`, `verify_rounds` consumidas, `stall_strikes`, costo_pond por estrategia y por fase completada; `escalation.ms` suma a `supervision_minutes` (H11).
- **Capítulos**: cap. 3 cierra la brecha diseño→artefacto (el boceto l.836-845 pasa a implementación; actualizar el párrafo aclarando que Strategy se realizó por compilación, no por herencia); bitácora IMPL gana su fila (vía SPEC-10).

### Riesgos y mitigaciones
- **Bifurcación por la puerta trasera** (cada estrategia acumula ifs en graph.ts): regla dura — toda capacidad entra como campo de `LoopPolicy` + bloque aislado; `strategyToPolicy` es la ÚNICA tabla de despacho; test que asserta `react` ≡ identidad.
- **Enum `EVENT_TYPES` cerrado**: olvidar añadir los eventos nuevos rompe en runtime (Mongoose valida enum) → F2 los añade con test que persiste ambos tipos.
- **Lecciones contaminan C0**: inyección y escritura cuelgan de las mismas llaves que `--bare` ya apaga (`hydrate:false`/`summarize`); test explícito de exención.
- **Explosión de costo en orchestrator-workers**: presupuesto POR worker obligatorio con default (600 s c/u) + tope `workers.max ≤ 8`; el evento `spawn` existente audita el fan-out.
- **`instructions` come ventana en modelos 7B**: clamp a 4000 chars al inyectar (lección del clamp de `routeSkills`) + campo `toolset` reservado para SPEC-05.
- **Plan/reflect + ESC hereda el bug de doble-user en resume** (graph.ts:166-178/286-307): no se arregla aquí — dependencia explícita de SPEC-04; mientras, el turno de plan persiste user+assistant de forma atómica antes de abrir el loop (ventana de exposición mínima).
- **`llmVerifier` con modelo débil** (falsos pass): la rúbrica exige JSON con `jsonSchema`; si el parseo falla la ronda cuenta como NO-pass con feedback "evaluator unparseable" (nunca aprueba por accidente).

### Dependencias
- **SPEC-02 (tiering)**: `evaluator.tier` y el provider del turno de plan resuelven contra el router de tiers; hasta entonces degradan a `secondary`/provider del run (definido aquí, sin bloqueo).
- **SPEC-04 (cli)**: fix del doble-user en resume para reanudar runs interrumpidos a mitad de una estrategia; `/loop` se apoya en el estado de sesión del chat.
- **SPEC-05 (filetools)**: campo `toolset` del spec (reservado aquí, consumido allá).
- **SPEC-06 (multiagent)**: `orchestrator-workers` + `--worktree` y coordinación (AACL por referencia); esta spec solo compila el fan-out lógico existente.
- **SPEC-09 (telemetry)**: consume los eventos `strategy_phase`/`escalation` para el timeline forense.
- ADR-0070/AACL: sin dependencia directa (solo vía SPEC-06).
