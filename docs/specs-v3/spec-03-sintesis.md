## SPEC-03 — Síntesis post-llamada obligatoria, gate de memoria al cierre, auto-activación y destilación de skills/agents
**Requisitos que cubre:** 5, 7, 11, 13, 14 (habilita el 12 vía SPEC-09)

### Objetivo y motivación
Que NINGUNA sesión termine sin dejar conocimiento durable y que TODO conocimiento durable vuelva solo a la mesa de trabajo. Hoy la síntesis de cierre es best-effort y truncada, el `--bare` de C0 filtra memoria al store de C2, el router de skills solo corre dentro de `runAgent`, y la KB acumulada nunca se convierte en skills/agents nuevos. Esta spec cierra el ciclo completo: **cerrar = sintetizar (tier `synthesize`) + recibo de memoria verificable + release coordinado**, **activar = router en todas las superficies**, **crecer = destilación KB→skill/agent (tier `design`) con aprobación humana**. Cierra además el ítem 2 del cap. 5 de la tesis ("la captura de sesión debe sintetizar; hoy trunca el prefijo del transcript").

### Estado actual (anclas de código verificadas)
- **Truncado real**: `src/memory/lifecycle.ts:335-353` `summarizeTranscript()` hace `.slice(0, 12_000)` sobre el transcript unido (línea 339) antes de UNA sola llamada LLM; el fallback determinista corta a 2000 chars (línea 352). En cambio `src/memory/synthesizer.ts:44-59` (`chunkTexts`, `SYNTH_CHUNK_CHARS=12_000`) y `Synthesizer.summarize()` (líneas 196-215) ya implementan map-reduce SIN truncado con fallback extractivo nunca-en-blanco — el mecanismo correcto existe pero no se usa para sesiones.
- **Captura sin modelo**: `captureSession()` (`src/context/capture.ts:312-412`) acepta `provider` y lo pasa a `summarizeSession` (línea 387), pero el comando `aitl capture-session` (`src/cli.ts:2152-2212`) NUNCA lo pasa (línea 2190) → el hook Stop de Claude Code (instalado en `src/init/initRepo.ts:373-395`) siempre cae al extractivo truncado. Es el "capture-session escribe 0 chars" de la campaña haiku.
- **Cierre sin gate**: `runAgent` (`src/orchestration/graph.ts:181`) llama `summarizeSession` en un try/catch silencioso (líneas 767-779) y luego marca `status:"done"` incondicionalmente (líneas 794-813). El run doc no registra si la memoria se escribió.
- **Fuga C0→C2 HOY**: `run --bare` (`src/cli.ts:283`) apaga `hydrate/skills/gates` pero NO `summarize` → un run C0 escribe `session-<runId>` al store que luego hidrata corridas C2. Bug de validez experimental abierto.
- **Superficies sin activación**: `routeSkills` (`src/projectctx/router.ts:93-146`; `limit` default 3 en línea 110, `maxChars` 6000 en línea 112, cascada lexical→recencia→rerank semántico) solo se invoca desde `runAgent` (graph.ts:370 skills, 383 agents). `run-host` solo hidrata memoria (`src/hosts/run.ts:101-109`), el comando `aitl hydrate` del hook `UserPromptSubmit` tampoco rutea skills (`src/cli.ts:2117-2146`), y `aitl chat` pone `skills:false` en todo turno con `resume` (`src/repl/chat.ts:499`) y `summarize:false` siempre (chat.ts:474).
- **Coordinación**: `releaseTask` (`src/coord/claims.ts:274-305`, `RELEASE_OUTCOMES=["done","abandoned"]` línea 261) libera con outcome `done` sin exigir evidencia de memoria. Tool MCP `release_task` en `src/mcpserver/server.ts:1374-1390` (RBAC `coordination:update`, línea 273).
- **Piezas para destilar**: `buildDefinition()` (`src/builder/buildDefinition.ts:60-83`) upsertea skill/agent con scaffold; tools `build_definition`/`write_skill`/`write_agent` con RBAC `agents_skills:create` (server.ts:260-264); tool `synthesize` con provider por invocación (server.ts:1507-1557); espejo a disco `.aitl/{memory,skills,agents}/<slug>.md` por `aitl sync` (`src/sync/sync.ts:4-7`); constrained decoding `CompleteOpts.jsonSchema` (ADR-0044). `RESERVED_MEMORY_TYPES` excluye tipos reservados de la compactación (synthesizer.ts:121).
- **Subagentes**: el orchestrator pone `summarize:false` por subagente y resume él solo (`src/orchestration/orchestrator.ts:99`). `EVENT_TYPES` en `src/models/event.model.ts:23-54` (enum cerrado: hay que extenderlo).

### Diseño

#### D1. `summarizeLong`: fin del truncado (compartido captura + loop)
Extraer el patrón map-reduce del Synthesizer a un helper reutilizable en `src/memory/synthesizer.ts`:
```ts
export async function summarizeLong(
  instruction: (notes: string) => string,
  sources: string[],
  llm: Provider | null,
  opts: { chunkChars?: number } = {},          // default SYNTH_CHUNK_CHARS
): Promise<string | null>                       // null ⇒ sin LLM o respuesta vacía (caller decide fallback)
```
`summarizeTranscript()` (lifecycle.ts) pasa a: partir el convo en `chunkTexts` → `summarizeLong` con la instrucción actual ("Preserve decisions, conventions, bugfixes, file paths and any [[links]]") → si `null`, fallback extractivo actual (conclusiones del assistant). El `.slice(0, 12_000)` desaparece; firma pública de `summarizeSession` intacta (aditivo). El resumen final añade una cabecera determinista con los datos de `ParsedTranscript` (turnos, tokens, `artifacts.decisions/memories`, `editedPaths` → base del timeline de SPEC-09).

#### D2. `closeoutRun`: cierre unificado con recibo de memoria
Módulo nuevo `src/memory/closeout.ts`:
```ts
export interface MemoryReceipt { slug: string; category: string; chars: number; mode: "llm" | "extractive"; at: Date; }
export interface CloseoutOpts {
  store?: MemoryStore; provider?: Provider;     // default: getTierProvider("synthesize") de SPEC-02
  taskKey?: string;                             // claim coord a liberar tras el recibo
  extraTags?: string[]; gate?: "enforce" | "warn" | "off";  // default settings.memoryGate
  minChars?: number;                            // transcript menor ⇒ skip honesto (receipt null, ok:true)
}
export async function closeoutRun(project: string, runId: string, convo: Msg[], opts?: CloseoutOpts):
  Promise<{ ok: boolean; receipt: MemoryReceipt | null; released: boolean }>
```
Cadena determinista en `enforce`: (1) tier `synthesize` → (2) cadena de fallback de providers → (3) extractivo local (solo requiere Mongo — el mismo Mongo que necesita el run doc, así que si el update de cierre puede persistir, el recibo también). Escribe la memoria ANTES de estampar el cierre; `RunModel.updateOne` del final de `runAgent` añade `memory_receipt` (campo Mixed opcional en `run.model.ts`, backward-compatible). Emite evento nuevo `memory_gate` `{ok, slug, mode, attempts, gate}` (añadir a `EVENT_TYPES`). Con `taskKey`, encadena `releaseTask({outcome:"done"})` tras el recibo y etiqueta la memoria `task:<taskKey>`. Publica `coord_events` tipo `release` (ya lo hace releaseTask) — AACL lo empujará por SSE cuando aterrice (por referencia).

Integración por superficie:
- **`runAgent`** (graph.ts:765-779): sustituir el bloque summarize por `closeoutRun`; `RunAgentOpts` gana `taskKey?: string` y `closeout?: CloseoutOpts`. Resultado expone `memory_receipt`.
- **`--bare` / C0**: `src/cli.ts:283` y `run_agent` MCP (server.ts:1268) añaden `summarize:false` al mapeo de `bare` — el run C0 NO escribe memoria (cierra la fuga C0→C2); test canario: `run --bare` deja `memories` intacta.
- **`aitl chat`**: se mantiene `summarize:false` por turno (chat.ts:474), pero al salir (`/exit`, Ctrl-D, y nuevo slash `/close`) corre `closeoutRun` UNA vez sobre el transcript completo del `runId` de la sesión (leído de `messages` vía `store.getMessages`).
- **`run-host`** (`src/hosts/run.ts`): tras persistir el turno assistant (línea 148-150), `closeoutRun` con el par prompt/resultado (el transcript rico llega por el hook Stop → capture-session, que ya sintetiza por D3; el closeout del run-host cubre Codex/Antigravity sin hooks).
- **orchestrator**: subagentes siguen `summarize:false` (orchestrator.ts:99); el master hace `closeoutRun` con `links` a los `run_id` hijos.
- **coord**: `releaseTask` gana `opts.memorySlug?: string` y, con `settings.memoryGate==="enforce"`, un release `outcome:"done"` sin `memorySlug` verifica que exista memoria etiquetada `task:<taskKey>` posterior al claim; si no: `{ok:false, reason:"memory_required"}` (nuevo miembro de `ReleaseResult`). Tool MCP `release_task` extendida con `memory_slug: z.string().optional()`.
- **capture-session** (D3) estampa el mismo `memory_receipt` en el run capturado.

Config nueva (patrón zod de `src/config.ts` + espejo perfil/.env de ADR-0061): `AITL_MEMORY_GATE=enforce|warn|off` (default `enforce`), `AITL_CLOSEOUT_MIN_CHARS=400`, `MODEL_TIER_SYNTHESIZE` (consumido vía SPEC-02).

#### D3. Captura que sintetiza (ítem 2 del cap. 5)
`aitl capture-session` (cli.ts:2152) gana `--synthesize` (default ON) y `--provider <slot|tier>`: construye el provider del tier `synthesize` (con fallback y último recurso extractivo) y lo pasa en `CaptureOpts.provider` — el parámetro ya existe y ya llega a `summarizeSession` (capture.ts:387); solo faltaba poblarlo. Con D1, el transcript completo se resume por map-reduce. Extra: `componentTags()` (capture.ts:216-232) filtra rutas fuera del cwd (arregla el gotcha `component:tmp/...`). El hook instalado por `aitl init` no cambia de forma (mismo comando, nuevo default), pero `initRepo.ts` añade `--source claude-code` explícito ya presente y documenta `--no-synthesize` para hosts sin red.

#### D4. Auto-activación en todas las superficies (requisito 13)
Módulo nuevo `src/projectctx/activation.ts` que extrae y generaliza el triple bloque de graph.ts:355-397:
```ts
export interface ActivationResult { preamble: string; skills: string[]; agents: string[]; sections: Record<string, number>; }
export async function activateContext(project: string, prompt: string, opts?: {
  store?: MemoryStore; surface: "run" | "chat" | "run-host" | "hook" | "mcp";
  hydrate?: boolean; skills?: boolean; agents?: boolean;
  limit?: number; maxChars?: number;            // defaults nuevos: settings.skillsLimit / settings.skillsMaxChars
}): Promise<ActivationResult>
```
Compone `hydrate()` + `routeSkills(kind skill)` + `routeSkills(kind agent, filter rol)` y loguea `hydrate`/`skills_route` con `payload.surface` (enum `EVENT_TYPES` sin cambios para estos). Cambios en el router (`src/projectctx/router.ts`), aditivos:
1. **Triggers de primera clase**: si `metadata.triggers: string[]` (keywords/globs) matchea el prompt, el skill entra FORZADO al top del ranking antes del presupuesto — revive el campo hoy inerte.
2. **Filtro de aprobación**: excluir registros con `metadata.approved === false` (los destilados pendientes de D5 no se activan solos).
3. Presupuestos por config: `AITL_SKILLS_LIMIT` (3) y `AITL_SKILLS_MAX_CHARS` (6000); una LoopSpec (SPEC-01) puede sobreescribirlos por perfil de modelo (un 7B recibe menos — disciplina compartida con SPEC-05).

Despliegue por superficie:
- **`runAgent`**: refactor a `activateContext` (comportamiento idéntico, mismo orden de preámbulos).
- **`run-host`** (run.ts:101-109): reemplaza el `hydrate` suelto — los hosts delegados reciben también skills/agents en el prompt.
- **Hook `UserPromptSubmit`**: `aitl hydrate` (cli.ts:2117) gana `--skills` (default ON, `--no-skills` para volver al viejo comportamiento) y llama `activateContext` con `surface:"hook"`, `rerank:false` (rápido, coherente con `--no-vector`). Los markdowns generados (skills destiladas, memorias espejadas por `aitl sync --pull`) quedan activos sin carga manual: el router lee la colección, y `aitl sync` es el puente disco↔colección.
- **`aitl chat`**: en turnos con `resume`, `runAgent` acepta `skills: "refresh"`: rutea contra el prompt NUEVO, diffea contra `selected_skills` del run doc y antepone SOLO los bloques nuevos al turno user dentro de `<skill-activation>…</skill-activation>` (inyección por turno user, no system: seguro para la alternancia estricta de Anthropic; no toca el fix del doble-user de SPEC-04). chat.ts:499 pasa de `skills:false` a `skills:"refresh"`.
- **MCP**: tool nueva de solo lectura `activate_context` — `{ project: z.string(), prompt: z.string(), limit: z.number().int().positive().optional(), max_chars: z.number().int().positive().optional(), surface: z.enum(["mcp","hook","run-host"]).default("mcp") }` → `{preamble, skills, agents, sections}` vía `runLogged` (sin entrada en `TOOL_RBAC`: no muta, mismo trato que `get_repomap`). Es el contrato de hidratación para Codex/Antigravity de SPEC-08.

#### D5. Destilación generativa KB→skill/agent (requisito 14)
Módulo nuevo `src/memory/distill.ts`:
```ts
export const DistillProposalSchema = z.object({
  kind: z.enum(["skill", "agent"]), name: z.string().regex(/^[a-z0-9-]{3,48}$/),
  description: z.string().max(300), content: z.string().min(200),
  rationale: z.string(), sources: z.array(z.string()).min(1),   // slugs de memoria / ids ADR
  confidence: z.number().min(0).max(1),
});
export async function distillKnowledge(project: string, opts?: {
  provider?: Provider;            // default getTierProvider("design") — la KB entera exige el mejor modelo
  maxProposals?: number;          // default settings.distillMaxProposals (3)
  kinds?: ("skill" | "agent")[]; dryRun?: boolean;
}): Promise<{ proposals: DistillProposal[]; written: string[]; skipped: { name: string; reason: string }[] }>
```
Pipeline: (1) corpus = memorias vivas + syntheses + decisiones activas + top prompts (vía `MemoryStore.iterMemory` + `list_decisions`), empaquetado con `chunkTexts` al contexto del tier design; (2) map: candidatos por chunk; reduce: consolidación final con `CompleteOpts.jsonSchema = DistillProposalSchema[]` (constrained decoding, ADR-0044); (3) dedup: `search_skills`/cosine > 0.85 contra existentes ⇒ `skipped: "similar_exists"` (una mejora a un skill existente se emite como memoria `type:"distill-proposal"` con el diff propuesto, nunca sobreescribe); (4) escritura vía `buildDefinition()` con `tags:["distilled","pending-review"]` y `metadata:{approved:false, distilled_from: sources, distill_run: runId, confidence}`; (5) evento nuevo `distill` (añadir a `EVENT_TYPES`) con stats.
**Guardrails de auditoría**: nada destilado se activa sin humano — el router lo excluye (D4.2); `aitl distill review` lista pendientes con fuentes y rationale; `aitl distill approve <name>` voltea `approved:true`, quita `pending-review` y sugiere `aitl sync --push` (espejo a `.aitl/skills/<name>.md`, versionado en git); `aitl distill reject <name>` borra el registro y escribe memoria `distill-rejected-<name>` (el destilador no re-propone lo rechazado: entra al dedup). `distill-proposal` se añade a `RESERVED_MEMORY_TYPES` (no se compacta).
Superficies: CLI `aitl distill {run,review,approve,reject}`; tool MCP `distill_knowledge` — `{ project: z.string(), kinds: z.array(z.enum(["skill","agent"])).optional(), max_proposals: z.number().int().min(1).max(10).default(3), dry_run: z.boolean().default(false) }`, RBAC `distill_knowledge: { resource: "agents_skills", action: "create" }` (entrada en `TOOL_RBAC` + canario en `mcpserver/rbac.test.ts`); opt-in periódico `aitl synthesize --distill` (tras compactar, destila).

### Fases de implementación
- **F1 — Síntesis sin truncado** (D1+D3): `summarizeLong` compartido; `summarizeTranscript` map-reduce; `capture-session --synthesize` con tier synthesize; filtro cwd en `componentTags`. Verifica: unit con transcript >30k chars (todas las porciones llegan al fake provider; 0 bytes perdidos), `node --test src/memory src/context`, E2E vivo: `aitl capture-session --project aitl-js --transcript <jsonl real>` produce memoria con síntesis (no primera-línea) y `npm run verify` verde.
- **F2 — Closeout + gate de memoria** (D2): `closeout.ts`, `memory_receipt` en run model, evento `memory_gate`, `--bare` exento (fix de fuga), cierre en chat/run-host/orchestrator, `releaseTask` con `memory_required`, `release_task` MCP con `memory_slug`. Verifica: unit de la cadena enforce (LLM caído ⇒ recibo extractivo), canario "`run --bare` no escribe memoria", canario RBAC, E2E: `aitl run "toca un archivo" --project demo` termina con `memory_receipt.slug` visible en `aitl run-show`.
- **F3 — Auto-activación** (D4): `activation.ts`, refactor graph.ts, run-host + `hydrate --skills` + chat `skills:"refresh"`, triggers + filtro approved en router, tool `activate_context`. Verifica: suite del router (triggers fuerzan inclusión; `approved:false` nunca sale), unit del diff de refresh, E2E: hook `UserPromptSubmit` inyecta sección "## Project skills" en una sesión Claude Code real; `run-host --no-hydrate` sigue limpio (C0 intacto).
- **F4 — Destilación** (D5): `distill.ts`, CLI distill, tool MCP + RBAC + canario, `RESERVED_MEMORY_TYPES`, flujo approve/reject. Verifica: unit con provider fake (schema zod validado, dedup, rechazo persistente), E2E vivo contra la KB real de `aitl-js`: `aitl distill run --dry-run` propone ≥1 skill plausible con fuentes reales; tras `approve`, `aitl sync --push` lo espeja y una corrida nueva lo activa (evento `skills_route` lo lista).

### ADRs a registrar
- «Cierre de sesión con gate determinista de memoria: closeoutRun, memory_receipt y release coordinado» (proposed → accepted en F2).
- «La captura de sesión sintetiza con map-reduce del tier synthesize; fin del truncado de transcripts» (proposed).
- «Activación automática de contexto (skills/agents/memoria) en todas las superficies vía activateContext» (proposed).
- «Destilación generativa de skills/agents desde la KB con aprobación humana obligatoria» (proposed).

### Medición para la tesis
- **Cierra el ítem 2 del cap. 5** (captura sintetiza): métrica nueva en `tab:metrics` — *cobertura de memoria*: % de runs con `memory_receipt` (objetivo 100% en C2) y *ratio de compresión* chars-transcript/chars-síntesis; medible re-corriendo las celdas c2 de la campaña (donde capture-session escribió 0 chars — el contrafactual ya está medido).
- **Continuidad entre sesiones** (req. 7): en la campaña confirmatoria n≥3, comparar celda c2 con gate `enforce` vs `off` (condición nueva `c2-gate` en `tab:cond`): fases completadas en sesión N+1 tras cortar en N.
- **Activación**: evidencia por eventos `skills_route.payload.surface` (pestaña ToolCalls ya la expone); costo de inyección en tokens lo mide SPEC-09 por tier.
- **Destilación**: *capacidad sin compromiso evaluativo* (justificado: es generativa y requiere juicio humano; mismo trato que roles H11 degradado). Se reporta como evidencia cualitativa: skills destiladas aprobadas y su adopción (apariciones en `skills_route`).

### Riesgos y mitigaciones
- **Costo de sintetizar cada run** → tier `synthesize` barato (SPEC-02), `AITL_CLOSEOUT_MIN_CHARS` salta transcripts triviales, y el extractivo es gratis.
- **404 del provider primario rompe la cadena** (bug memoria `provider-chutes-404-en-synthesize`) → dependencia dura del fix de FallbackProvider en SPEC-02; mientras tanto el paso (3) extractivo garantiza el recibo.
- **Contaminación C0→C2** → `--bare ⇒ summarize:false` + test canario permanente; documentar en la bitácora que corridas C0 previas a F2 pudieron filtrar.
- **Inflar la ventana del host con skills en el hook** → presupuesto `AITL_SKILLS_MAX_CHARS`, `rerank:false` en hook, `--no-skills` de escape; SPEC-09 mide el delta.
- **Gate que bloquea trabajo legítimo** → `enforce` degrada solo, nunca falla el run: sin Mongo no hay run doc que marcar, con Mongo el extractivo siempre escribe; `warn` disponible por config.
- **Destilación de basura o prompt-injection desde la KB** → doble candado: schema zod estricto + `approved:false` por default con router que lo excluye; el contenido destilado jamás se ejecuta, solo se inyecta tras aprobación; rechazos persistentes evitan la re-propuesta.
- **Doble-user en resume al inyectar refresh** → la inyección va DENTRO del turno user nuevo, nunca como mensaje extra; coordinación explícita con el puente assistant de SPEC-04.

### Dependencias
- **SPEC-02 (`tiering`)**: `getTierProvider("synthesize"|"design")` y el fix del FallbackProvider ante 404 — F1/F2 lo consumen (hasta entonces, `getProviderWithFallback` actual + extractivo).
- **SPEC-01 (`loops`)**: LoopSpec extendida puede fijar `closeout` y presupuestos de activación por estrategia (campo opcional; no bloqueante).
- **SPEC-04 (`cli`)**: `/close` y el re-render conviven con el fix del doble-user; la inyección refresh se coordina con su puente assistant.
- **SPEC-05 (`filetools`)**: comparte la disciplina de presupuesto de contexto (toolsets por perfil ↔ skills por perfil).
- **SPEC-08 (`hosts`)**: `activate_context` y `closeoutRun` son el contrato hidratar/capturar del HostAdapter genérico (Codex vía AGENTS.md llama las tools MCP).
- **SPEC-09 (`telemetry`)**: consume `memory_receipt`, `memory_gate` y la cabecera determinista de D1 para el timeline `aitl session show`.
- **AACL (ADR proposed, por referencia)**: los eventos `release`/`memory_gate` viajarán por su canal push SSE/WS cuando aterrice; esta spec solo publica al bus existente (`coord_events`).
