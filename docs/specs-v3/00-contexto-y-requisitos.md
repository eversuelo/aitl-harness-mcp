# Contexto compartido — Diseño de PLAN-HARNESS-V3 (AITL)

Eres parte de un panel de diseño que produce las specs del plan "Harness V3" para AITL-Harness-JS,
el harness agéntico de la tesis del usuario. Este archivo es tu contexto base: léelo COMPLETO antes
de explorar el repo. Todo lo afirmado aquí fue verificado por exploración el 2026-07-17.

## Repos

- **Harness**: `/home/eversuelo/Code/thesis-harness/AITL-Harness-JS` (TypeScript ESM, Node ≥20, rama `feat/harness-v2`, paquete `aitl-mcp`, binario `aitl`). Project key MCP canónico: `aitl-js`.
- **Tesis**: `/home/eversuelo/Code/thesis-harness/thesis-harnesss` (LaTeX español, book.tex, capítulos en `sections/chapter-0N/chapter.tex`, bitácora `adr/bitacora-decisiones-implementacion.tex`).

## Pedido del usuario (requisitos literales, 4 mensajes)

1. Extender MUCHO el harness (tipo claude-code, asiste desarrollo de código) y que funcione. Es para su tesis.
2. **Agentic loops**: motor + una guía + forma fácil de configurarlos.
3. **Más tools para escribir en archivos**.
4. **Mejor CLI que se rehidrate y re-renderice**.
5. **Al final de cada llamada**: invocar aitl-js + un modelo de bajo costo para **sintetizar el conocimiento** de la sesión.
6. **Tiering de modelos**: el mejor LLM diseña, el intermedio implementa, el barato sintetiza. Modelos sugeridos de **Chutes AI u OpenRouter** como orquestador y sintetizador.
7. **No perder contexto entre sesiones**.
8. **Multiagentes** trabajando, incluso `--worktree` si se puede. El harness debe poder **lanzar subagentes**.
9. **Engancharse a otro harness como hook para hidratar memoria**; intercambio de host: **Codex, Agy (=Antigravity) e independiente** (el harness solo).
10. **La memoria como ledger**: saber qué ADRs/decisiones se tomaron, en qué repos, y **si ya se hizo merge a main**.
11. **Las tools de memoria SIEMPRE se llaman al finalizar un requerimiento/task** (obligatorio, no convención) para no perder contexto.
12. **Plan de medición de gasto en tokens**: ¿es eficiente?, medido **por modelo**; y cerrar el problema de que **el análisis de qué se hizo en cada sesión está incompleto**.
13. **Auto-activación**: los markdowns generados y las skills necesarias se activan de forma AUTOMÁTICA al usar el harness (en todas las superficies: run, chat, run-host, MCP), sin carga manual.
14. **Síntesis generativa**: las sesiones de síntesis pueden DESARROLLAR nuevos agentes o skills a partir del knowledge base, usando un modelo apto para analizar toda la KB (destilación conocimiento→skill/agent, con las tools build_definition/write_skill/write_agent existentes y guardrails de auditoría).
15. **Embeddings**: el usuario duda que los embeddings locales (Xenova/all-MiniLM-L6-v2, 384 dims, `src/ingest/embedder.ts`, `EMBEDDING_PROVIDER=local|voyage`) funcionen de verdad en su entorno — nunca los verificó. Decisión requerida: auditar E2E y (a) removerlos, o (b) sustituir/respaldar con un proveedor remoto de embeddings vía OpenRouter o Chutes AI (con re-embedding coherente de dims en el índice Atlas).
16. **Catálogo de capacidades de modelos + failover de host/modelo**: clasificar cada modelo según su mejor uso; una forma FÁCIL de deducir qué modelo trabajó qué (desde la telemetría real de runs) y si es apto para re-calls (resume/multi-turno/tool-calling confiable); si un host adapter se queda sin tokens/cuota, cambiar de host o de modelo SUGIRIÉNDOSELO al usuario (no silencioso). Nota: esto revive la pieza "C1: colección models + binding" que la tesis tenía como pendiente del DoD. El orquestador (harness o host adapter bajo el modelo adecuado) usa este catálogo al lanzar subagentes.
17. **Multimodalidad**: hoy el soporte es CERO end-to-end (content: string en todo el pipeline; verificado 2026-07-17: los hits de image/vision en src/ son falsos positivos de "supervisión"/"revisión"). Pero las 3 capas externas ya son multimodales sin que el harness las use: SDK Anthropic (bloques image), OpenAI-compat/OpenRouter/Chutes (image_url, VLMs), protocolo MCP (image content en tool results, el cliente lo aplana), y los hosts Claude Code/Codex/Antigravity. Caso de uso estrella para la tesis: verificación VISUAL del render del raytracer (el verifier compara el PNG contra la referencia de escena). Ruta aditiva: content string|ContentPart[], bloques en ambos adaptadores, flag vision en el catálogo de modelos (SPEC-11), tool view_image/screenshot, imágenes en memoria como artefactos referenciados con caption textual (embeddings siguen text-only).

## Estado actual del harness (mapa verificado)

### Ledger y convenciones
- ADRs 0001–0075 contiguos en Mongo (colección `decisions`) espejados a `docs/adr/NNNN-slug.md` vía `aitl sync`. **Next-free aparente: 0076, pero NUNCA se pinnean números de ADR en docs/planes** — el id se lee next-free en el momento de BUILD. Los planes se registran con ADR `status: proposed` (precedente: PLAN-REPOMAP-V2 → su propio ADR proposed).
- Formato ADR: Nygard (`# ADR-NNNN — título`, Status/Date/Components, Context/Decision/Consequences con deuda técnica explícita).
- Convenciones duras: `npm run verify` verde por fase (typecheck + `node --test`, ~445 casos en 56 archivos); Mongoose dueño único de datos (`src/models/*.model.ts`, 26 modelos); todo aditivo/backward-compatible; docs y CLI en **español** (preámbulos inyectados en inglés); toda llamada MCP con `project: "aitl-js"`; cierre de sesión = memorias + ADR + `aitl sync --pull`.
- Planes previos: PLAN-HARNESS-V2.md (P1–P11 COMPLETO, ADRs 0046–0059) y PLAN-REPOMAP-V2.md (ADR proposed; F1 HECHA = símbolos ricos; **F2 symbol_edges/call-graph, F4 get_impact, F3 --classes, F5 hydrate symbol-brief PENDIENTES**). AACL (coordinación push SSE/WS + leases por archivo + detect_conflicts + DAG) es otro ADR proposed pendiente. **La V3 debe ABSORBER estos planes abiertos por referencia, no duplicarlos.**

### Arquitectura (src/, 207 archivos .ts)
- **Loop**: `src/orchestration/graph.ts` `runAgent(prompt, project, opts)` (línea ~181). ReAct puro resumible desde transcript durable (colección `messages`); `resume: runId` recarga con `rebuildConvo` (graph.ts:166-178) y la rama resume (graph.ts:286-307). Stop reasons: `completed|max_iters|verify_exhausted|stalled|budget|interrupted`. Loop engineering ADR-0062: budgets {tokens,ms}, stall detector (`stall.ts`), reflect, verifiers componibles, **LoopSpec versionada content-hash** (`loopspec.ts`, precedencia flags > spec > defaults). Al cierre: `summarizeSession` + checkpoint de roles + rollup del run.
- **BUG conocido de resume tras ESC**: si el último mensaje persistido fue `user` (feedback de verify/stall) y se interrumpe, el resume anexa OTRO `user` → dos `user` consecutivos sin turno assistant (Anthropic exige alternancia). No existe "puente assistant". Puntos exactos: graph.ts:166-178 y 286-307.
- **Subagentes**: `src/orchestration/orchestrator.ts` `orchestrate()` — master delgado: `planSubtasks` → un `runAgent` por subtask en paralelo (`Promise.allSettled`), cada uno con su propio `ToolRegistry` y `ContextManager`. CLI `aitl orchestrate`. **NO HAY WORKTREES** (grep = 0). Aislamiento solo lógico.
- **Council**: `src/council/` (propuestas paralelas + crítica anónima + juez, ADR de plan-council). **Coord**: `src/coord/` (task claims atómicos con caducidad, eventos, `aitl coord poll`).
- **Providers**: `src/providers/base.ts`. Slots: `anthropic` (SDK nativo, default claude-opus-4-8), `openrouter`, `lmstudio` (autodetección /api/v0), `openai-compat` (hoy = **Chutes**, BASE_URL https://llm.chutes.ai/v1). `MODEL_PRIMARY/SECONDARY` + `AITL_API_KEY` clasificada por prefijo (cpk_* de Chutes NO se auto-clasifica). `getProviderWithFallback` → `FallbackProvider` (base.ts:251-323). **BUG abierto: un 404 del provider primario NO degrada la cadena** (memoria `provider-chutes-404-en-synthesize`) — propaga el error en vez de saltar al siguiente. `MODEL_HOST=codex|claude-code|antigravity` está **reservado en config y sin consumir**.
- **MCP server**: `src/mcpserver/server.ts` `buildServer()` — **58 tools** (48 `server.tool()` + 10 de `registerDefinitionTools`). Patrón para tool nueva: `server.tool(name, desc, zodSchema, handler)` + envolver en `runLogged` (RBAC guard + log + persistencia en `mcp_tool_calls` con redacción de secretos) + entrada en `TOOL_RBAC` (server.ts:241-277) si muta + canario en `mcpserver/rbac.test.ts`. Tools existentes relevantes: `synthesize` (provider por invocación), `coord_status`, `publish_event`, `run_agent` (loop completo por MCP), `record_decision`, `write_memory`, `get/update/delete_memory`, `list_branches`, `sync_branches`, `index_repo`, `graphify`.
- **Memoria**: `src/memory/` — store con vector→text→recencia (`lifecycle.ts` `hydrate()` línea ~236, presupuestado por fuente, best-effort), versionado append-only `*_history` (ADR-0027), anclaje a `commit_sha` (0049), síntesis map-reduce con fallback extractivo nunca-en-blanco (`synthesizer.ts`, ADR-0059), compactación rodante `compacted_into`. Embeddings locales MiniLM 384 dims (o Voyage).
- **Captura de hosts**: `src/context/capture.ts` `captureSession()` (parsea JSONL de Claude Code, autodescubre transcript, error si 0 turnos salvo `allowEmpty`). Hooks reales instalados por `aitl init` (`src/init/initRepo.ts:373-395`): `UserPromptSubmit → aitl hydrate --no-vector`, `Stop → aitl capture-session` + `aitl coord poll --quiet`. Codex no tiene hooks → contrato vía AGENTS.md. **La tesis (cap5) dice: "la captura de sesión debe sintetizar; hoy trunca el prefijo del transcript"** — brecha exacta del requisito 5.
- **Hosts**: `src/hosts/base.ts` `HOST_SPECS` (claude-code/codex/antigravity) + `run.ts` (`aitl run-host`); tokens de host runs ADR-0034. `src/adapters/` exporta a cursor/copilot/kiro/trae/antigravity/agentsMd.
- **Tools del loop**: `src/tools/` — ToolRegistry con **gates → pre-hooks → run → post-hooks** (base.ts:118-161), `filesystem.ts`, `shell.ts`, `edit_file` (reemplazo exacto, ADR-0064), `mcp_add` (0066). Gates: denyPathsGate (.git, *.env, *.pem, id_rsa), approval `--ask` (mide supervision_minutes), `adrGuard` (post-hook que anota ediciones con ADRs cuyos components[] matchean; capa LLM-mode DIFERIDA en TODO.md).
- **CLI**: `src/cli.ts` (2814 líneas, Commander, ~40 comandos). `aitl chat` = REPL ANSI manual + readline/promises + `AnsiMarkdownStream` (`src/repl/chat.ts`, markdown.ts); slash commands /help /model /tools /mcp /new etc.; `runId` persiste entre turnos y se pasa como `resume` con hydrate:false. `aitl interactive` = panel supervisor readline que respawnea el CLI como hijos. **No usa Ink.** No hay re-render de transcript al reanudar ni selector de sesiones.
- **Config**: capas env real > perfil `AITL_PROFILE` (`~/.aitl/profiles/*.json`) > `.env` > `~/.aitl/config.json` > defaults zod (ADR-0061); espejo doble profile↔.env; wizard web loopback + `aitl init` idempotente.
- **Web**: SPA React18+Vite+Tailwind+shadcn — pestañas Workspace (árbol software→project→repo→branch), Memory, Decisions, Prompts, Runs (tokens/costo/iters), ToolCalls (evidencia de hidratación), Graph, Knowledge Map, Config.
- **Catálogo**: software → projects → repos → branches (ADR-0028/0031). `branches` tiene kind/base/head_sha/protected pero **NO estado de merge** — brecha exacta del requisito 10. `decisions` tienen `branch` + `commit_sha` + `components[]`.
- **Telemetría actual**: run docs con tokens/toolCalls/costo; `docs/token-accounting.md` (snapshot vs acumulado, caching); `mcp_tool_calls` con args/result redactados; `tool-calls-report`. La tesis usa `costo_pond` (tokens crudos no comparables por caché 98%). **No hay catálogo de precios por modelo ni atribución por tier, y la reconstrucción de "qué se hizo en la sesión" es incompleta** — brecha del requisito 12.

### Bugs/gotchas abiertos (además de los ya citados)
- Trabajo del 2026-07-12 SIN COMMITEAR en el working tree (ambos repos); el MCP server corriendo puede ser build viejo.
- `capture-session` etiqueta `component:tmp/...` (rutas fuera de cwd sin filtrar).
- Hook de hidratación en `UserPromptSubmit`, en tensión con ADR que prefería `SessionStart`.
- Skill `pair` de roles se ejecuta igual que `review`; campo `triggers` persiste pero no dispara.

## Lo que la tesis promete (para anclar cada spec)

- Tesis: el resultado no depende solo del modelo sino de contexto+tools+proceso+verificación. Fórmula: Ejecución agéntica = Evento + Meta + Modelo + Harness + Loop + Humano. Hipótesis H1–H10. Paradigma DSR + caso raytracer (fases F0–F5, check.sh objetivo, celdas condición×modelo, C0 `--bare` vs C2, tope 60 min, métricas ISO 25010 en `tab:metrics`, costo_pond).
- **Cap. 3 (líneas 816-845) YA DISEÑA `LoopStrategy` como Strategy con ids `retry|react|reflexion|plan-execute|evaluator-optimizer|orchestrator-workers` — nunca implementado.** Tensión a cuidar: IMPL "bucle único runAgent" → las estrategias deben PARAMETRIZAR runAgent, no bifurcarlo.
- Cap. 5 pide: síntesis real en captura (ítem 2), división de trabajo entre modelos (§division, hoy par diseña-verifica/implementa; celda exploratoria `c2-sonnet-spec` diseñada), campaña confirmatoria n≥3.
- **Worktrees NO aparecen en la tesis; "sistema multiagente complejo" está declarado FUERA de alcance en cap. 1** → si multiagente pasa a evaluarse, actualizar delimitación de alcance + coordinación v2.
- Costo del contrato de tools: ~80% de la ventana de un 7B se va en esquemas → crecer la superficie de tools EXIGE toolsets por perfil / carga diferida.
- Toda extensión entra como (a) condición/métrica nueva en `tab:cond`/`tab:metrics` para ser MEDIBLE, o (b) capacidad del artefacto sin compromiso evaluativo (precedente: roles H11 degradado). Archivos transversales que siempre se tocan: bitácora IMPL, cifra "68 ADRs" (aparece en preface, cap1 ×2, cap3 ×2, cap5 ×2), THESIS-STATE.md, respuestas-preguntas-vs-hipotesis.md.

## Decisiones marco de la V3 (tomadas por el orquestador — respétalas)

1. El entregable es **PLAN-HARNESS-V3.md** en la raíz del repo del harness, siguiendo el estilo de PLAN-HARNESS-V2.md (fases + verificación por fase), y se registrará como ADR `proposed` + memoria MCP.
2. La V3 se organiza en **10 specs** (abajo). Cada spec debe poder implementarse en 1-3 sesiones y cerrar con `npm run verify` verde.
3. Naming de tiers de modelo: **`design` / `implement` / `synthesize`** (env `MODEL_TIER_DESIGN`, etc.), mapeados a los slots de provider existentes; Chutes y OpenRouter como gateways sugeridos.
4. Nada de números de ADR pinneados; nada de reescrituras big-bang: todo aditivo sobre los puntos de extensión reales (`RunAgentOpts`, ToolRegistry hooks, `server.tool`+`runLogged`+`TOOL_RBAC`, modelos Mongoose nuevos o campos opcionales).
5. Los planes abiertos ADR-0070 (repomap F2-F5) y AACL se absorben POR REFERENCIA (la spec que los necesite los cita como dependencia, no los re-especifica).
6. Español para el doc; identificadores de código en inglés.

## Las 10 specs

- SPEC-01 `loops` — Motor de agentic loops declarativos: implementar el contrato LoopStrategy del cap. 3 DENTRO de runAgent (parametrización, no bifurcación); extender LoopSpec (ADR-0062) a estrategias; config declarativa fácil (`.aitl/loops/*.md|yaml` versionados content-hash); CLI `aitl loop {list,show,init,run}`; guía `docs/LOOPS.md`; exposición vía `run_agent` MCP.
- SPEC-02 `tiering` — Router de tiers design/implement/synthesize: binding tier→provider+modelo; el orquestador planifica con design, subagentes con implement, síntesis/summaries con synthesize; sugerencias CONCRETAS de modelos en Chutes/OpenRouter con precios aproximados y criterio de elección; fix del FallbackProvider ante 404 (degradar, no propagar); health-check de slots (`aitl models --check`).
- SPEC-03 `sintesis` — Síntesis post-llamada obligatoria + destilación generativa: al cierre de CADA run/task, síntesis con el tier synthesize hacia la memoria aitl-js; capture-session que sintetiza en vez de truncar (cierra el ítem 2 del cap. 5); **gate determinista de cierre: un task/run no queda `done` sin escritura de memoria** (verifier componible + coord release + evento); cuidado con fuga C0→C2 (--bare exento). ADEMÁS (requisitos 13-14): auto-activación garantizada de skills/markdowns generados en todas las superficies (extender el router: hoy ≤3 skills ~6000 chars, lexical→recencia→semántica, y NO corre en run-host/chat), y **sesiones de síntesis capaces de DESTILAR nuevos skills/agents desde la KB completa** con un modelo apto (design-tier), vía build_definition/write_skill/write_agent + espejo a disco por aitl sync, con auditoría/aprobación.
- SPEC-04 `cli` — CLI que se rehidrata y re-renderiza: fix del doble-user en resume (puente assistant en rebuildConvo/rama resume); `aitl chat --resume` con re-render del transcript completo desde `messages` por el AnsiMarkdownStream; selector de sesiones recientes; status line (modelo/tier/tokens/costo vivo); manténte en el stack readline+ANSI actual.
- SPEC-05 `filetools` — Más tools de archivos para el loop: write_file, multi_edit, apply_patch, glob, grep (ripgrep si está), read con rangos, mkdir/mv/rm gateados por denyPaths+approval; y GESTIÓN DEL COSTO de esquemas: toolsets por perfil/modelo (un 7B no recibe 58 schemas), carga diferida de tools, perfiles de toolset en LoopSpec.
- SPEC-06 `multiagent` — Subagentes con `--worktree`: aislamiento por git worktree por subagente (creación, cwd del ToolRegistry, política de merge/cleanup, límites), integración con coord claims y con AACL (leases por archivo) POR REFERENCIA; fan-out del orchestrator con presupuesto por subagente; eventos spawn enriquecidos.
- SPEC-07 `ledger` — Memoria como ledger de decisiones con estado de merge: campo/cálculo `merge_status` (¿la rama de la decisión ya aterrizó en main/master?) vía git (`merge-base --is-ancestor` / `branch --merged`) en `sync_branches` + branches catalog; superficie: tool MCP (p.ej. `decision_status` o extensión de `list_decisions`), CLI `aitl adr status`, columna en web Decisions; hydrate avisa "decisiones aún no aterrizadas en main"; multi-repo (project→repos).
- SPEC-08 `hosts` — Intercambio de host y hooks para otros harnesses: consumir `MODEL_HOST`; subagentes delegables a hosts (claude-code/codex/antigravity) desde el orchestrator; contrato genérico de HostAdapter para hidratar/capturar en harnesses ajenos (Claude Code hooks YA; Codex vía AGENTS.md+notify; Antigravity vía adapter existente); modo independiente (Cara A) como primera clase.
- SPEC-09 `telemetry` — Medición de gasto en tokens por modelo + forense de sesión completa: catálogo de precios por modelo/proveedor (colección editable + seed), costo real y costo_pond por run/tier/task/sesión cache-aware; métricas de eficiencia (costo por fase completada, por gate pass); CLI `aitl cost report` + pestaña web; y reconstrucción COMPLETA de "qué se hizo en cada sesión": timeline narrativo desde events+messages+mcp_tool_calls (`aitl session show <runId>`), enlazado a la síntesis de SPEC-03.
- SPEC-10 `thesis` — Integración con la tesis: por cada spec 01-09 (y 11), qué filas IMPL añade la bitácora, qué capítulos/labels se tocan, qué condición/celda/métrica nueva la hace medible (p.ej. celda c2-tiered, métrica de costo por tier), actualización de alcance (multiagente/worktrees), y el plan de medición (qué celdas re-correr, presupuesto de corridas).
- SPEC-11 `modelcat` — Catálogo de capacidades de modelos + failover (requisito 16, revive C1 models+binding de la tesis): colección `models` con clasificación por mejor uso (design/implement/synthesize/orquestación), aptitud para re-calls (resume, multi-turno, tool-calling confiable, context window), costo; **deducción automática desde telemetría** (runs históricos: qué modelo trabajó qué, tasa de verify pass, stalls, tool-errors por modelo); binding tier→modelo y agent/rol→modelo; **protocolo de handoff**: detectar agotamiento de tokens/cuota/contexto de un host o modelo (429/402/límites) → proponer AL USUARIO cambio de host o modelo (evento + prompt interactivo + sugerencia razonada), nunca silencioso; el orquestador consulta el catálogo al asignar subagentes. Dependencias: SPEC-02 (router), SPEC-08 (hosts), SPEC-09 (telemetría).

**Adición a SPEC-02 (requisito 15):** decidir el futuro de los embeddings: auditoría E2E del pipeline local Xenova/MiniLM (¿funciona? ¿el índice Atlas tiene los vectores?), y diseño de la alternativa: slot de embeddings remoto vía OpenRouter/Chutes (o remoción limpia con fallback a $text), incluyendo la migración de dims del índice si cambia el proveedor. Evidencia preliminar de que SÍ funciona: search_memory devuelve scores 0.65-0.67 típicos de $vectorSearch coseno.

- SPEC-12 `multimodal` — Multimodalidad aditiva (requisito 17): F-entrada (content string|ContentPart[] retrocompatible en message.model + adaptadores anthropic/openai arman bloques image; CLI /image y --image; flag vision en catálogo SPEC-11 para que el router elija VLM vía OpenRouter/Chutes), F-tools (resultados de tool con imagen: view_image, screenshot; ToolRegistry y cliente MCP dejan de aplanar), F-memoria (imágenes como artefactos referenciados con hash + caption sintetizado a texto — embeddings siguen text-only; preview en web), F-verificación-visual (verifier del loop que VE el render del raytracer y lo compara con la referencia — instrumento de medición para la tesis, no solo feature). Dependencias: SPEC-11 (flag vision), SPEC-02 (router/providers), SPEC-05 (tools).

## Formato OBLIGATORIO de cada spec (para ensamblar el doc final)

Escribe tu spec como markdown con EXACTAMENTE esta estructura de headings (empieza en `## `):

```
## SPEC-NN — <título corto>
**Requisitos que cubre:** <números de la lista del pedido del usuario>
### Objetivo y motivación
### Estado actual (anclas de código verificadas)
### Diseño
(sub-secciones libres: modelo de datos, módulos nuevos/tocados con rutas, tools MCP nuevas
con nombre+schema zod+RBAC, comandos CLI, config/env, flujos)
### Fases de implementación
(F1..Fn; cada fase = entregable concreto + cómo se verifica: comando, test, E2E)
### ADRs a registrar
(títulos con status propuesto, SIN números)
### Medición para la tesis
(métrica/condición/capítulo; o "capacidad sin compromiso evaluativo" justificado)
### Riesgos y mitigaciones
### Dependencias
(con otras SPECs y con ADR-0070/AACL si aplica)
```

Sé específico y creativo: nombres de archivo reales, firmas de funciones, esquemas de colección,
ejemplos de config. Ambición alta PERO cada pieza anclada a los puntos de extensión reales listados
arriba. Si detectas que algo del pedido ya existe, dilo y diseña la extensión, no el duplicado.
