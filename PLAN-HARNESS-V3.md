# PLAN-HARNESS-V3 — Extensión mayor del harness AITL

- **Fecha:** 2026-07-17
- **Estado:** propuesto (registrado como ADR `proposed` en el ledger + memoria `plan-harness-v3`)
- **Relación con planes previos:** sucede a PLAN-HARNESS-V2 (P1–P11, COMPLETO). Absorbe **por referencia** los dos planes abiertos: PLAN-REPOMAP-V2 (fases F2–F5 pendientes) y AACL (coordinación push/leases/DAG) — ninguna spec los re-especifica.
- **Specs completas:** `docs/specs-v3/spec-01-*.md … spec-12-*.md` (contexto y requisitos en `docs/specs-v3/00-contexto-y-requisitos.md`).

## Contexto

El usuario pidió una extensión mayor ("V3") del harness para su tesis, con 17 requisitos acumulados
en la sesión del 2026-07-17 (lista completa en `00-contexto-y-requisitos.md`): continuidad total de
contexto entre sesiones, síntesis obligatoria al cierre con un modelo barato, tiering de modelos
(diseña el mejor / implementa el intermedio / sintetiza el barato, vía Chutes/OpenRouter), agentic
loops configurables con guía, más tools de archivos, CLI que se rehidrata y re-renderiza, subagentes
con `--worktree`, intercambio de host (Claude Code / Codex / Antigravity / independiente), memoria
como ledger de decisiones con estado de merge a main, gate obligatorio de memoria al cerrar cada
task, telemetría de gasto en tokens por modelo, forense de sesión completa, auto-activación de
skills/markdowns, destilación generativa de skills/agents desde la KB, veredicto sobre los
embeddings locales, catálogo de capacidades de modelos con failover sugerido al usuario, y
multimodalidad.

El plan se elaboró con 3 agentes exploradores (arquitectura de `src/`, docs/ADRs 0001–0075, y el
repo de la tesis) + 12 agentes de diseño anclados al código real + críticos adversariales
(ver «Estado de validación»). Profundiza el posicionamiento vigente de **sistema cognitivo dual**
(memoria `product-positioning`): Cara A harness propio, Cara B capa cognitiva sobre hosts externos.

## Requisito → Spec

| # | Requisito (resumen) | Spec(s) |
|---|---|---|
| 1 | Extender mucho el harness, tipo claude-code, que funcione | todas |
| 2 | Agentic loops: motor + guía + config fácil | 01 |
| 3 | Más tools para escribir en archivos | 05 |
| 4 | CLI que se rehidrate y re-renderice | 04 |
| 5 | Síntesis al final de cada llamada con modelo barato → aitl-js | 03 |
| 6 | Tiering design/implement/synthesize (Chutes/OpenRouter) | 02 |
| 7 | No perder contexto entre sesiones | 03, 04, 09 |
| 8 | Multiagentes + `--worktree` + lanzar subagentes | 06 |
| 9 | Hooks de hidratación en otros harnesses; hosts Codex/Antigravity/independiente | 08 |
| 10 | Ledger de decisiones por repo con estado de merge a main | 07 |
| 11 | Tools de memoria SIEMPRE al cerrar un requerimiento/task | 03 |
| 12 | Medición de tokens por modelo + forense de sesión completo | 09, 10 |
| 13 | Auto-activación de skills/markdowns generados | 03 |
| 14 | Sesiones de síntesis que desarrollan skills/agents nuevos | 03 |
| 15 | Veredicto embeddings locales (¿funcionan?) o remotos OpenRouter/Chutes | 02 |
| 16 | Catálogo de modelos por mejor uso + aptitud re-calls + failover sugerido | 11 |
| 17 | Multimodalidad | 12 |

## Las 12 specs

| Spec | Título | Esencia |
|---|---|---|
| [01 loops](docs/specs-v3/spec-01-loops.md) | Estrategias de bucle declarativas | El contrato `LoopStrategy` del cap. 3 de la tesis (react, reflexion, plan-execute, evaluator-optimizer, orchestrator-workers) implementado como **compilación a política** dentro de `runAgent` — parametriza, no bifurca (respeta el "bucle único" de IMPL-0047). LoopSpec (ADR-0062) gana `strategy/instructions/evaluator/workers/escalate/toolset`; config fácil en `.aitl/loops/*.md\|yaml` (gray-matter ya vendorado); CLI `aitl loop {list,show,init,run,lint}` + `/loop` en chat; `registerDefinitionTools("loop")` en MCP; guía `docs/LOOPS.md`. Gotcha verificado: `EVENT_TYPES` es enum cerrado — los eventos nuevos deben añadirse ahí. |
| [02 tiering](docs/specs-v3/spec-02-tiering.md) | Router de tiers + fix 404 + embeddings | `src/providers/tiers.ts` con `MODEL_TIER_{DESIGN,IMPLEMENT,SYNTHESIZE}=slot[:modelId]` — un solo slot Chutes sirve modelos distintos por tier; defaults = conducta actual (100% retrocompatible). Fix del 404 en 3 capas: `classifyProviderError` + cuarentena TTL en `FallbackProvider` + degradación terminal a extractivo en el Synthesizer (el bug real: cadena de 1 eslabón + catch ausente). Health-check sin gastar tokens (`aitl models --check`, tool MCP `provider_health`). **Embeddings: veredicto mantener + respaldar** — auditoría E2E con self-query ≥0.99 (`aitl embeddings audit`), slot remoto `OpenAICompatEmbedder` (Chutes sí; OpenRouter no tiene /embeddings), migración de dims re-embed con cascada `$text` como red. |
| [03 sintesis](docs/specs-v3/spec-03-sintesis.md) | Síntesis obligatoria + gate + auto-activación + destilación | `summarizeLong` map-reduce compartido (fin del `.slice(0,12000)` que truncaba transcripts — el "capture-session escribe 0 chars" de la campaña haiku); `closeoutRun` con `memory_receipt` verificable y gate `AITL_MEMORY_GATE=enforce`: **ningún run/task cierra `done` sin memoria escrita** (y `releaseTask` exige evidencia); `--bare` exento — arregla la fuga C0→C2 descubierta en el diseño; `capture-session --synthesize` con tier synthesize (cierra el ítem 2 del cap. 5); `activateContext` lleva el router de skills a TODAS las superficies (run, run-host, hook, chat con `skills:"refresh"`, tool MCP `activate_context`) y revive el campo `triggers` hoy inerte; destilación KB→skill/agent con tier design, constrained decoding, dedup semántico y **aprobación humana obligatoria** (`aitl distill {run,review,approve,reject}`, tool `distill_knowledge`). |
| [04 cli](docs/specs-v3/spec-04-cli.md) | CLI que se rehidrata y re-renderiza | Fix del doble-`user` en resume como **invariante del transcript durable**: puente assistant persistido y taggeado `resume_bridge` (módulo puro `src/orchestration/transcript.ts`) — no parches por provider; el chat como vista re-computable: `src/repl/replay.ts` re-renderiza `messages` con el `AnsiMarkdownStream` existente (`aitl chat --resume`, `/replay`); selector de sesiones readline (`aitl sessions` + picker, sin Ink); status line viva (modelo/tier/tokens/costo) vía observador aditivo `onTurn`. Cero tools MCP nuevas. |
| [05 filetools](docs/specs-v3/spec-05-filetools.md) | Tools de archivos + toolsets + carga diferida | `read_file` con rangos, `multi_edit` atómico, `apply_patch` unified multi-archivo (parser TS puro), `glob`/`grep` (ripgrep con fallback JS — `rg` NO está en esta máquina, verificado), `mkdir/move_path/remove_path` gateados; **declaración única `PATH_ARGS`/`WRITE_TOOLS`** que generaliza `denyPathsGate` y `adrGuard` (hoy hardcodean 3 tools); `workspaceGate` de confinamiento (la pieza que SPEC-06 cablea al worktree); **toolsets versionados por content-hash** (`full/core/fs/readonly/mini`) elegidos por perfil/tier/modelo + meta-tool `tool_search` de carga diferida — el antídoto al dato de la tesis de que ~80% de la ventana de un 7B se va en esquemas; `schema_tokens` estampado por run. |
| [06 multiagent](docs/specs-v3/spec-06-multiagent.md) | Subagentes con `--worktree` | Worktrees fuera del repo (`~/.aitl/worktrees`) vía `src/worktree/manager.ts` (GitDeps inyectable), ramas `aitl/sub/*` con trailer `Aitl-Run` para forense; cwd cableado como `WorkspaceOpts` aditivo + `worktreeScopeGate` + `RunAgentOpts.workspaceRoot`; 4 políticas de integración con default **branch-only (nunca auto-merge)**; merge serializado con merge-lock vía `claimTask` (el índice único parcial ES el mutex); claims por subtarea `sub:<runId>:<i>`, budgets por subagente, evento `spawn` enriquecido + 3 tipos nuevos; tool MCP `orchestrate_task`. AACL solo por referencia. |
| [07 ledger](docs/specs-v3/spec-07-ledger.md) | Estado de merge en el ledger de decisiones | Doble señal: commit-nivel (`merge-base --is-ancestor` sobre `commit_sha`, gana) con fallback rama-nivel cacheado en `branches`; campos derivados `merge_status/merged_into/merge_checked_at` escritos por `$set` directo — **jamás vía ADRStore**, para no bumpear el versionado append-only; campo `decision.repo` + resolución multi-repo commit-first; squash-merges recuperados con `git cherry` (patch-id); refresh gratis reutilizando el hook post-merge de `aitl init`; superficies: tool `decision_status`, `aitl adr status --refresh`, MergeBadge en la web, aviso ⚠ en hydrate ("decisiones aún no aterrizadas en main") leyendo solo cache Mongo — cero git en el hot path. |
| [08 hosts](docs/specs-v3/spec-08-hosts.md) | Intercambio de host + hooks para otros harnesses | `MODEL_HOST` (hoy sin consumidor) pasa a router de superficie standalone\|host en `aitl run`; contrato `HostIntegration` declarativo (hydration hook\|file\|prompt × capture hook\|notify\|wrap): claude-code = hooks actuales extraídos, Codex = bloque gestionado en AGENTS.md (`aitl hydrate --into`) + notify→`aitl host-notify` con parser codex-jsonl, Antigravity = adapter existente; delegación de subagentes a hosts (`OrchestrateOpts.delegate` + `metadata.host`, dato hoy huérfano que por fin se consume) + `parent_run_id`; tools MCP `run_host`/`list_hosts`; celda exploratoria `c2-host-codex`. **Única spec con crítica adversarial completa** — 3 pendientes medios a resolver en BUILD: binding `agentMeta` inexistente en D5, clobber de GEMINI.md por el AntigravityAdapter, y asimetría de degradación ADR-0060 en `aitl run`. |
| [09 telemetry](docs/specs-v3/spec-09-telemetry.md) | Costo por modelo + forense de sesión | Colecciones nuevas `model_prices` (catálogo editable con seed, match por prefijo, multiplicadores de caché) y `llm_calls` (una fila por llamada: modelo real post-fallback, tier, purpose, usage con caché — que `anthropic.ts` hoy descarta — y costo snapshot); metering como decorador `meterProvider` (best-effort, kill-switch); **timeline forense merge-sort** de messages+events+mcp_tool_calls+llm_calls (`aitl session show <runId>`) corrigiendo 3 huecos verificados: `mcp_tool_calls` sin run_id, `spawn` sin child_run_id, sin `parent_run_id`; `aitl cost report` (+ `--csv`); `costo_pond` implementa la fórmula exacta de `docs/token-accounting.md`. Cierra el requisito 12: "qué se hizo en cada sesión" deja de ser arqueología manual. |
| [10 thesis](docs/specs-v3/spec-10-thesis.md) | Integración con la tesis | La **matriz D1** spec→{filas IMPL, capítulos/labels, celda/métrica o justificación C} es la fuente de verdad; exportador `aitl adr export-tex` (la bitácora va 7 ADRs atrás del ledger — deuda verificada); macro `\adrcount` + `scripts/check-tesis-sync.sh` (protocolo de cifra canónica "68 ADRs", `LC_ALL=C`); alcance cap1:282 reescrito quirúrgicamente (worktrees como capacidad, cláusula de activación) sin tocar el canon H1–H10 (hipótesis nuevas → namespace HC1); **campaña confirmatoria**: 5 celdas × n=3 (15 cursos, incl. `c2-tiered@mix` nueva) + 3 exploratorias, techo 150 USD con criterio de recorte, bitácoras forenses generadas con `aitl session show`. |
| [11 modelcat](docs/specs-v3/spec-11-modelcat.md) | Catálogo de modelos + failover | Colección `models` con cards declared vs **observed** (recomputado por `computeObserved` puro desde runs+events; `model_ref` estampado porque `run.model` hoy guarda el slot, no el modelo); `recall_fitness` determinista (fit/degraded/unfit/unknown, umbral ≥5 runs) — responde "¿qué modelo trabajó qué y es apto para re-calls?"; bindings por proyecto (tier/agent/role/loop→card+fallbacks); **handoff no-silencioso**: `classifyExhaustion` (429/402/overflow) solo en la capa provider, `exhausted_until` + eventos `model_exhausted/handoff_proposed/accepted` — el salto dentro de la cadena configurada se conserva, pero ningún binding/host cambia sin confirmación del usuario (prompt en TTY, `suggestions[]` headless); 4 tools MCP + `aitl models {--seed,--deduce,--suggest,bind,show}`. Revive la pieza "models+binding" (C1) del diseño original de la tesis. |
| [12 multimodal](docs/specs-v3/spec-12-multimodal.md) | Multimodalidad aditiva | `ContentPart` (text\|image con source base64/path/artifact): `message.model` conserva `content:string` y añade `parts[]` con `artifact_hash` — jamás base64 en Mongo; adaptadores arman bloques (Anthropic nativo; OpenAI-compat reemite imágenes de tool results como user turn sintético); flag `vision` en `ProviderCapabilities`/catálogo SPEC-11 con degradación a caption avisada; `RichToolResult` + `ToolRegistry.callRich` (compat: `call()` devuelve `.text`); `view_image`/`screenshot` en toolset perfil vision; cliente MCP deja de aplanar image content; `ArtifactStore` content-addressed (`.aitl/artifacts/<hash>`) + caption del tier synthesize; **verificación visual**: `imageCompareVerifier` (PPM puro TS, tolerancia = `check.sh`) + `vlmVisionVerifier` — el determinista decide, el VLM solo da feedback; puebla la columna `imagen_ok` del CSV (vacía en todo el piloto) post-hoc, sin cursos extra. |

## Orden de ejecución (olas)

Cada spec se implementa en 1–3 sesiones por fase, cerrando con `npm run verify` verde + E2E + ADR + `aitl sync --pull`.

- **Ola 0 — Instrumento y fundaciones** (prerrequisitos de todo lo demás):
  SPEC-02 (tiers + fix 404 + veredicto embeddings) · SPEC-04 F1 (puente assistant: elimina corridas inválidas) · SPEC-09 F1–F2 (catálogo de precios + metering).
- **Ola 1 — La memoria nunca se pierde** (corazón del pedido):
  SPEC-03 completa (síntesis+gate+auto-activación+destilación) · SPEC-09 F3–F4 (forense `session show`) · SPEC-10 F1–F2 (bitácora al día + protocolo de sincronía).
- **Ola 2 — Superficie de trabajo**:
  SPEC-05 (filetools+toolsets) · SPEC-01 (loops) · SPEC-07 (ledger de merge) · SPEC-04 F2–F4 (replay/selector/status line).
- **Ola 3 — Escala multiagente y hosts**:
  SPEC-06 (worktrees) · SPEC-08 (hosts, resolviendo sus 3 pendientes de crítica) · SPEC-11 (modelcat+failover).
- **Ola 4 — Frontera y campaña**:
  SPEC-12 (multimodal) · SPEC-10 F3–F5 (alcance, instrumentación y campaña confirmatoria ≤150 USD).

Dependencias duras entre specs: 03→02 (tier synthesize + fix 404), 05⇄01 (campo `toolset` de LoopSpec, aditivo), 06→05 (`workspaceGate`), 11→{02,09}, 12→{11,02,05}, 10→casi todas (matriz D1). ADR-0070 F2–F5 (call graph, `get_impact`) y AACL corren como planes hermanos — las specs los citan, no los implementan.

## Estado de validación (honestidad del proceso)

Las 12 specs fueron diseñadas por agentes que verificaron cada ancla contra el código real
(rutas, funciones, líneas). La **crítica adversarial independiente** (segundo agente intentando
refutar cada spec) solo pudo completarse para **SPEC-08** antes de agotar el límite de sesión:
encontró 18/18 anclas correctas, cero duplicación, y 5 issues (3 medios listados arriba, 2 menores).
Las otras 11 specs quedaron **sin crítica independiente**. Mitigación recomendada (dogfooding):
antes del BUILD de cada spec, pasarla por `aitl council` (plan-council, ADR de la tesis) o repetir
el pase adversarial; como mínimo, tratar cada ancla de línea como "aprox." y re-verificarla al editar.

## Verificación global del plan

1. Por fase: `npm run verify` (typecheck + ~445 tests) + el E2E indicado en cada spec + canarios RBAC cuando se añaden tools MCP.
2. Por spec: ADR registrado (id next-free leído del ledger en BUILD — **nunca pinneado aquí**) + espejo `aitl sync --pull --project aitl-js` + fila(s) IMPL vía `aitl adr export-tex`.
3. Del plan completo: la campaña confirmatoria de SPEC-10 D6 (15 cursos confirmatorios + 3 exploratorios) es la prueba final de que "funciona" en el sentido de la tesis — con `c0-bare` intacto como control (el gate de síntesis respeta `--bare`).

## Convenciones (recordatorio operativo)

Docs en español · identificadores en inglés · todo aditivo/backward-compatible · Mongoose dueño único
de datos · `project: "aitl-js"` en toda llamada MCP · cierre de sesión = memorias + ADR + sync
(ahora con gate de SPEC-03) · números de ADR jamás pinneados en docs.
