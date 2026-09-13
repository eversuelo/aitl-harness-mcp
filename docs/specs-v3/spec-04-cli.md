## SPEC-04 — CLI que se rehidrata y re-renderiza (resume sano + selector de sesiones + status line)
**Requisitos que cubre:** 4 (mejor CLI que se rehidrate y re-renderice), 7 (no perder contexto entre sesiones — cara CLI); apoya 12 (visibilidad de gasto en vivo; la métrica formal es de SPEC-09).

### Objetivo y motivación

`aitl chat` ya es un REPL multi-turno sobre el loop durable, pero al morir el proceso se pierde la CARA VISUAL y la CARA DE CONTEXTO de la sesión: no hay forma de reabrir un run y ver lo que pasó, ni de descubrir qué runs existen, el turno reanudado jamás rehidrata memoria (el REPL fija `hydrate:false` en todo resume), y el resume tras ESC puede producir un transcript inválido (dos `user` consecutivos) que rompe providers con plantillas de alternancia estricta (Anthropic, Mistral/jinja — bug diagnosticado el 2026-07-09, fix pendiente). Esta spec cierra cuatro brechas con un mismo hilo conductor — el transcript durable en `messages` es la única fuente de verdad y el CLI debe poder reconstruirlo COMPLETO: (a) invariante de alternancia + reparación del transcript en resume («puente assistant» y tool-results sintéticos), (b) re-render ANSI del transcript al reanudar + selector de sesiones recientes + `--continue`, (c) rehidratación de memoria al retomar una sesión, (d) status line viva con modelo/tier/tokens/costo. Todo dentro del stack actual readline + ANSI manual (decisión marco: sin Ink).

### Estado actual (anclas de código verificadas)

- **Loop y resume**: `src/orchestration/graph.ts` (830 líneas). `rebuildConvo(msgs)` líneas 166-178 (mapeo plano role/content/tool_calls, sin normalización ni reparación); rama resume líneas 286-307: recarga `store.getMessages(runId)`, y si `prompt` no es vacío lo anexa como turno `user` nuevo (299-304) SIN mirar el rol del último mensaje persistido. `appendUser` (línea 417) inyecta turnos `user` de feedback: reflect (463), budget wrap-up (517), verify fallido (635), stall (752). Checkpoints de interrupción: tope de iteración (497-501), mid-stream `StreamInterrupted` con descarte del turno en vuelo (592-596), entre tool calls con resultado sintético `"[interrupted by user — tool not executed]"` por call pendiente (650-665). **El bug**: interrupción justo después de un `appendUser` deja `user` como último turno persistido; el siguiente `resume` con prompt nuevo apila OTRO `user` → alternancia rota (memoria `bug-jinja-resume-interrupt`, reproducido en vivo: con puente, 200 OK). **Brecha adicional**: los tool-results sintéticos de 650-665 solo se escriben si el proceso sobrevive a la interrupción — un kill duro (SIGKILL/crash) entre persistir el `assistant(tool_calls)` y sus results deja el transcript durable terminando en tool_calls sin results, que OpenAI/Anthropic rechazan al reanudar.
- **Hidratación**: el system prompt se arma en graph.ts:355-398; `hydrate(project, promptText, { store })` (línea 361, de `src/memory/lifecycle.ts`) corre si `opts.hydrate !== false` — también en resumes. Pero el REPL lo apaga SIEMPRE en turnos reanudados (`chat.ts:499`), así que una sesión retomada en un proceso nuevo arranca sin contexto durable.
- **Observadores existentes** (`RunAgentOpts`, graph.ts:36-114): `onDelta` (68), `onTool` (73-79), `resume` (83, `""` = continuar sin turno nuevo), `signal` (113). Acumulación de tokens por turno en 482-483, 535-536 y 611-612 (`tokIn/tokOut`) — hoy solo se reporta al FINAL (`RunAgentResult.token_usage`, línea 148). Los `StreamDelta` no traen usage (`base.ts:42`).
- **REPL**: `src/repl/chat.ts` (533 líneas). `runId` vive solo en memoria del proceso (línea 210) y se pasa como `resume` con `hydrate:false, skills:false` (499); `sessionIn/sessionOut` arrancan en 0 aunque el run traiga historia (213-214); spinner en stderr con label fija «pensando…» (40-54); traza de tools `⏺ name(args) ✓ ms` vía `onTool` (482-497); línea de resumen post-turno con tokens/iters/runId (513-519); `summarize: false` por turno (474); slash commands 264-443 (no existe `/resume`, `/sessions`, `/replay` ni `/status`). `src/repl/markdown.ts`: `AnsiMarkdownStream` (clase 198, `push` 209, `flush` 216) y `renderMarkdownAnsi(text)` one-shot (303); identidad si `!TTY || NO_COLOR`. `src/repl/escape.ts` `listenForEscape` (33). `src/repl/history.ts` `historyFile(project)` → `~/.aitl/history/<project>` (línea 15) persiste historial de INPUT — pero no la vista del transcript.
- **Datos**: `src/memory/store.ts` `getMessages(runId)` (110-113, ordena por `idx`); `src/models/message.model.ts` schema con `run_id/idx/role/content/tool_calls[{id,name,input}]/tool_call_id/tokens/tags` (32-53); `src/models/run.model.ts` `_id` = UUID string app-supplied (37) y `strict:false` (52) → admite `$set` de campos nuevos sin migración; al cierre `runAgent` estampa `stop_reason/iters/tool_calls/token_usage/verified` (graph.ts:794-813) y el resume re-marca `status:"running"` (306).
- **CLI**: `src/cli.ts` (2814 líneas): comando `chat` (303-335) sin flag de resume (grep `resume` en cli.ts = 0 hits); `run-show` (466-522) da totales JSON pero no transcript legible; NO existe listado de sesiones (revisados los ~40 `.command(...)`). `src/config/store.ts` `ENV_KEYS` (línea 42) es el registro de claves de config (ADR-0061). `providerStatus()` en `src/providers/base.ts:204`; `estimateTokens` (~4 chars/token) en base.ts:66.
- **Colisión de nombres**: `src/models/session.model.ts` = sesiones de LOGIN WEB (ADR-0046, colección `sessions`). Las "sesiones de chat" de esta spec son documentos de `runs` — no se crea colección nueva.
- **Ya existe / no duplicar**: el resume mecánico del loop funciona (el chat multi-turno lo usa cada turno); lo que falta es la capa de INVARIANTE + la capa VISUAL + la capa de CONTEXTO. El render markdown y el historial de input se REUTILIZAN tal cual.

### Diseño

#### D1 — Invariante de alternancia y reparación del transcript en resume

Módulo nuevo `src/orchestration/transcript.ts` (funciones puras, testeables sin Mongo; `rebuildConvo` se MUEVE aquí desde graph.ts sin cambios de comportamiento):

```ts
export function rebuildConvo(msgs: Document[]): Record<string, unknown>[];
export function trailingRole(msgs: Document[]): "user" | "assistant" | "tool" | null;
/** ids de tool_calls del último assistant SIN tool-result persistido (kill duro). */
export function missingToolResults(msgs: Document[]): string[];
/** true ⇔ tras completar tool-results, el último turno efectivo es `user`/`tool`
 *  Y llega un prompt nuevo no vacío. */
export function needsBridge(msgs: Document[], newPrompt: string): boolean;
export const BRIDGE_CONTENT =
  "[reanudación: el turno fue interrumpido antes de que el asistente respondiera]";
export function makeBridgeInput(project: string, runId: string, idx: number): MessageInput;   // role assistant, tags ["resume_bridge"]
export function makeSyntheticToolInput(project: string, runId: string, idx: number,
  toolCallId: string): MessageInput;                                                          // role tool, tags ["synthetic_tool"]
export function assertAlternation(convo: Record<string, unknown>[]): string | null;           // null = ok; usado por tests
```

Cableado en la rama resume de graph.ts (286-307), tras `getMessages` y en este orden: (1) por cada id de `missingToolResults(msgs)` persistir un tool-result sintético (mismo texto que 650-665) y anexarlo a la convo — el caso kill-duro queda saneado; (2) si `needsBridge(msgs, prompt)` → `convo.push({ role: "assistant", content: BRIDGE_CONTENT })`, `idx += 1` y persistir el puente vía `store.appendMessage(await makeMessage(makeBridgeInput(...)))` — el transcript DURABLE queda alternante, así el siguiente resume no necesita caso especial; (3) recién entonces anexar el `user` nuevo. El evento `resume` (307) gana `payload.bridged: boolean` y `payload.repaired_tools: number`. Casos que NO puentean: prompt `""` (el modelo responde al feedback pendiente — semántica actual intacta), trailing `assistant` plano o `tool` con results completos (válidos). El puente es corto, neutro, en rol assistant y taggeado `resume_bridge` para que replay lo pinte distinto y `summarizeSession` (graph.ts:769) pueda excluirlo. La reparación vive en `runAgent`, no en el REPL: `run_agent` MCP, `orchestrate` y los loops de SPEC-01/06 la heredan gratis.

#### D2 — Re-render del transcript: `aitl chat --resume` y `/replay`

Módulo nuevo `src/repl/replay.ts`:

```ts
export interface ReplayOpts { markdown?: boolean; last?: number; width?: number }
/** Pura: fixture de messages + run doc → string ANSI. El wrapper con Mongo la envuelve. */
export function renderTurns(msgs: Document[], run: Record<string, unknown> | null, opts?: ReplayOpts): string;
export async function renderTranscript(runId: string, opts?: ReplayOpts): Promise<string>;
```

Reglas de render (mismo lenguaje visual del chat en vivo, chat.ts:482-497): cabecera `── run 1a2b3c4d · openai-compat · interrupted · ↑12.4k ↓3.2k tok · 2026-07-17 10:22 ──`; turno `user` → `❯ ` cyan + texto crudo; `assistant` → `renderMarkdownAnsi(content)` y por cada tool_call una línea `⏺ nombre(argPreview)` (reutiliza `argPreview`, chat.ts:57-63, que se exporta); `tool` → `  ⎿ ` dim con la primera línea truncada a 120 chars; mensajes con tags `resume_bridge`/`synthetic_tool` → una sola línea dim `(reanudado)`. `last` (default env `AITL_CHAT_REPLAY_TURNS` = 30) corta por la cola con aviso `… N turnos anteriores — /replay all`. La query de replay proyecta fuera `embedding` (nunca cargar vectores para pintar texto). Con `markdown:false` degrada a texto plano pipe-safe.

Integración en `chatRepl` (`ChatReplOpts` gana `resume?: string | "pick" | "continue"`): al arrancar con resume se valida el run contra `RunModel` (si `doc.project` difiere, gana el del run — graph.ts:291), se imprime `renderTranscript`, se asigna `runId` y se SIEMBRAN `sessionIn/sessionOut` desde `run.token_usage` (hoy arrancan en 0, chat.ts:213-214). Slash nuevos: `/replay [n|all]` (re-pinta el run actual — útil tras scroll o `/mcp` ruidoso) y `/resume [runId]` (cambia de sesión in-REPL vía el picker de D3). CLI: `aitl chat --resume [runId] --last <n>`; además `aitl run --resume <runId>` (continúa un run interrumpido NO interactivo: `runAgent("", project, { resume: runId, ... })` — la semántica prompt-vacío ya existe, graph.ts:82).

#### D3 — Selector de sesiones recientes + `--continue`

Módulo nuevo `src/repl/picker.ts` (IO inyectable, patrón `TaskIO` de ADR-0056):

```ts
export interface SessionRow { runId: string; title: string; status: string; stop_reason?: string;
  model: string; updated_at: Date; tokens: number }
export async function listSessions(project: string, limit?: number): Promise<SessionRow[]>;  // default 20
export function formatSessionRows(rows: SessionRow[], now?: Date): string;                   // pura
export async function pickSession(project: string, io?: PickIO): Promise<string | null>;     // readline numerado
export async function lastSessionId(project: string): Promise<string | null>;                // .lastrun → fallback Mongo
```

`listSessions`: `RunModel.find({ project }).sort({ updated_at: -1 }).limit(N).lean()`; descarta runs sin transcript (councils/hosts sin `messages` no son reanudables); `title` = `run.title ?? primer mensaje user recortado a 64 chars` — resuelto con UNA agregación sobre `messages` (`$match run_id ∈ ids, role:"user"` → `$sort idx` → `$group $first content`, sin N+1) y backfill `RunModel.updateOne({_id}, {$set:{title}})` la primera vez (`strict:false` lo permite, run.model.ts:52); el chat lo estampa en el primer turno de runs nuevos. Formato de fila: `2) ◐ hace 2h · fix del parser de fences… · openai-compat · ↑12k↓3k · 1a2b3c4d` con iconos `✳ running · ◐ interrupted · ✓ done · ✗ error` (un run `✳ running` puede ser huérfano de un crash; reanudable igual — graph.ts:306 re-marca running). `pickSession` imprime la tabla y pregunta `número (enter = más reciente · q = nueva sesión)` con `readline/promises` — cero dependencias nuevas.

**Última sesión por proyecto**: archivo `~/.aitl/history/<project>.lastrun` (junto al history de input, patrón `historyFile`) escrito best-effort al final de cada turno del chat; `lastSessionId()` lo lee y cae a Mongo (`sort updated_at desc`) si no existe. Superficies: `aitl chat --continue` (alias `-c`) reanuda la última sesión sin selector; `aitl chat --resume` SIN argumento → picker; comando nuevo `aitl sessions [--project] [--limit <n>] [--json]` (tabla no interactiva / JSON para scripts y para la web); `/resume` sin arg → picker in-REPL.

#### D4 — Rehidratación de memoria al reanudar

El primer turno tras un arranque con `--resume/--continue` (o tras un `/resume` que cambia de run) pasa `hydrate: true, skills: false` en vez del `hydrate:false` fijo actual (chat.ts:499); chatRepl mantiene un booleano `rehydrated` por sesión-de-run y los turnos siguientes vuelven a `hydrate:false`. `runAgent` no necesita cambios: la hidratación va al SYSTEM prompt (graph.ts:355-398), no contamina el transcript, y emite su evento `hydrate` auditable (363). Extensión aditiva en `lifecycle.ts`: `hydrate(project, prompt, { store, since?: Date })` — con `since = run.ended_at` prioriza memoria/ADRs posteriores a la última sesión («qué cambió desde que te fuiste»), default = comportamiento actual. Esto convierte el resume en una reanudación con contexto fresco, no solo con historial viejo (requisito 7).

#### D5 — Status line viva (modelo · tier · tokens · costo)

Observador nuevo, aditivo, en `RunAgentOpts` (mismo patrón observacional que `onTool`, graph.ts:73-79):

```ts
/** Telemetría por iteración: usage del turno + acumulado del run. Puramente observacional. */
onTurn?: (ev: { iter: number; usage: { input: number; output: number };
  totals: { input: number; output: number }; ms: number }) => void;
```

Se dispara en los TRES puntos donde graph.ts acumula tokens (482-483 reflect, 535-536 wrap-up de budget, 611-612 turno normal). Módulo nuevo `src/repl/status.ts`:

```ts
export interface StatusState { provider: string; tier?: string; in: number; out: number;
  costUsd?: number | null; iter: number; t0: number }
export function formatStatusLine(s: StatusState): string;
// → "openai-compat · tier implement · ↑12.3k ↓4.1k · $0.0087 · iter 3 · 42s"
```

En chat.ts, el `spinner(label)` (40-54) pasa a leer una label MUTABLE: `spinner(() => formatStatusLine(state))`; cada `onTurn` actualiza `state` y el redraw de 80 ms en stderr la refleja — sin tocar stdout, respetando el contrato «la primera salida real detiene el spinner» (475-497). Entre `onTurn`s, los chars streameados del turno en curso se estiman con `estimateTokens` y se RECONCILIAN al cierre con el usage real. La línea de resumen post-turno (513-519) gana `tier` y `costo`. **Costo vivo**: import dinámico best-effort de `estimateCostUsd(model, usage)` del catálogo de precios de SPEC-09 (`src/telemetry/pricing.ts`); sin catálogo o sin precio para el modelo → el campo se OMITE (nunca `$0.00` engañoso). **Tier**: si el provider llegó por el router de SPEC-02 trae `provider.tier` (`design|implement|synthesize`); si no, solo el nombre del slot. Slash nuevo `/status`: provider+tier, runId, tokens de sesión, costo estimado, servidores MCP montados, ask/md on-off.

#### Config, RBAC y superficie MCP

- ENV nuevas registradas en `ENV_KEYS` (`src/config/store.ts:42`) para que aparezcan en perfiles y en la pestaña web Config (ADR-0061): `AITL_CHAT_REPLAY_TURNS` (default `30`), `AITL_CHAT_STATUS` (`1|0`, default `1`).
- **Sin tools MCP nuevas**: la superficie de esta spec es 100 % CLI; `run_agent` MCP ya hereda la reparación D1 y `resume` por `RunAgentOpts` sin cambio de schema (los observadores no viajan por MCP). Sin entradas nuevas en `TOOL_RBAC`.

### Fases de implementación

- **F1 — Reparación del transcript (fix doble-user + kill duro)**. Entregable: `src/orchestration/transcript.ts` + recableado de la rama resume (graph.ts:286-307) + `transcript.test.ts` (needsBridge/missingToolResults/assertAlternation puros: trailing user, trailing tool, assistant plano, assistant+tool_calls sin results, transcript vacío, prompt `""`) + test de integración con FakeProvider: persistir `user` de feedback → interrumpir → `runAgent(prompt, ..., { resume })` → asertar que `getMessages` alterna, contiene el puente taggeado y que resume con `""` NO puentea. Verificación: `npm run verify` verde (typecheck + `node --test`, suite ~445); E2E vivo: `aitl chat`, forzar verify fallido, ESC durante el feedback, reabrir y continuar contra `anthropic` (alternancia estricta) y contra un modelo de plantilla jinja si LM Studio corre (reproductor del bug original).
- **F2 — Replay + `--resume <runId>` + `aitl run --resume`**. Entregable: `src/repl/replay.ts`, export de `argPreview`, `ChatReplOpts.resume`, siembra de `sessionIn/Out`, `/replay`, flags en cli.ts. Verificación: tests de `renderTurns` con fixture (user + assistant con tool_calls + tool + bridge; markdown on/off; `last`; proyección sin embedding); E2E: sesión de 3 turnos → salir → `aitl chat --resume <id>` re-pinta idéntico y el turno 4 continúa el mismo run (`aitl run-show <id>`: un solo run, idx contiguos).
- **F3 — Selector + `--continue` + rehidratación**. Entregable: `src/repl/picker.ts`, agregación de títulos + backfill, `.lastrun`, comando `aitl sessions`, `--resume` sin arg, `--continue/-c`, `/resume`, `/sessions`, flag `rehydrated` + `since` opcional en `hydrate()`. Verificación: tests puros de `formatSessionRows` (iconos por status/stop_reason, edad relativa) y `pickSession` con `PickIO` inyectada (número válido, enter, `q`, EOF); test del flag de rehidratación (primer turno reanudado hidrata, segundo no); E2E: `aitl sessions --json | jq '.[0].runId'`; `aitl chat --continue` re-pinta y su `aitl run-show` muestra el evento `hydrate` del turno reanudado.
- **F4 — Status line viva**. Entregable: `onTurn` en graph.ts (3 puntos de emisión), `src/repl/status.ts`, spinner con label mutable, `/status`, ENV nuevas en `ENV_KEYS`. Verificación: test de `formatStatusLine` (con/sin tier, con/sin costo, formateo k, recorte a `stderr.columns`) + test con FakeProvider de que `onTurn` dispara una vez por iteración con totales monotónicos y de que `runAgent` sin `onTurn` no cambia un byte del comportamiento persistido (canario); E2E visual en chat con provider streaming; `aitl config set AITL_CHAT_STATUS=0 --env` la apaga; pipe a archivo = stdout sin escapes ANSI.

Cada fase es aditiva y cierra con `npm run verify` verde; F1 es independiente y URGENTE (corrige instrumento); F2-F4 caben en 1-2 sesiones más. Ojo: graph.ts puede tener diffs sin commitear del 2026-07-12 en el árbol — reconciliar antes de F1.

### ADRs a registrar

- «Invariante de alternancia del transcript durable: puente assistant y tool-results sintéticos persistidos en resume» (status: proposed) — decide que la reparación vive en el TRANSCRIPT (durable) y no en cada mapeo de provider; consecuencia: los puentes son turnos reales taggeados, visibles en replay y excluibles de síntesis.
- «Rehidratación del CLI: replay de transcript, selector de sesiones sobre runs, última sesión por proyecto e hidratación delta al reanudar» (status: proposed) — decide NO adoptar Ink/TUI framework; el chat es una VISTA re-computable del transcript durable; `title`, `.lastrun` y `since` como extensiones aditivas.
- «Status line viva del REPL con telemetría por iteración (`onTurn`) y degradación por capacidades» (status: proposed).

### Medición para la tesis

Mayormente **capacidad del artefacto sin compromiso evaluativo** (la ergonomía del REPL no es condición experimental; precedente: roles H11 degradado). Tres anclajes medibles sí entran: (1) el fix del doble-user es PRERREQUISITO operativo de las celdas con interrupción — la celda sonnet/fase-07 se abortó a ~36 min con WIP irrecuperable; con F1+F2 una corrida interrumpida se reanuda, y el evento `resume{bridged, repaired_tools}` deja una tasa de reanudación exitosa (`resume_success` = resumes que completan turno sin error de provider) derivable de `events` SIN celda nueva — cap. 4, propuesta como métrica observacional de continuidad en `tab:metrics` vía SPEC-10 (requisito 7); (2) la rehidratación delta al reanudar es evidencia directa de «no perder contexto entre sesiones» — el evento `hydrate` del turno reanudado es contable por celda; (3) la status line consume el catálogo de SPEC-09 — la medición formal de costo por tier se acredita ALLÁ, aquí solo la superficie. Filas IMPL en la bitácora (`adr/bitacora-decisiones-implementacion.tex`) por F1 (bug cerrado, referencia al diagnóstico 2026-07-09) y F2-F4 (capacidad); sin tocar `tab:cond`.

### Riesgos y mitigaciones

- **El puente contamina el contexto del modelo** (turno assistant sintético que induce disculpas o re-planeo): contenido fijo de una línea, tag `resume_bridge`, filtro en `summarizeSession`; el costo (~15 tokens) es despreciable frente a un transcript inválido que ABORTA el run. Test E2E observa que el turno siguiente continúa la tarea.
- **Adaptadores**: un assistant plano tras results `tool` debe mapear bien en `toOpenAiMessages` (ADR-0043) y en el adaptador Anthropic — canario de round-trip por adaptador en F1.
- **Carrera spinner/stdout corrompe el render markdown**: la status line vive SOLO en stderr y muere con la primera salida real del turno (contrato actual de `stopSpin`); `formatStatusLine` se recorta al ancho de terminal (`process.stderr.columns`) para no envolver línea.
- **Replay de runs enormes** (cientos de turnos, tool results de MBs): `last` por defecto + truncado de resultados de tool a una línea; `renderTurns` es O(n) sobre strings ya ordenados por `idx`, con proyección que excluye `embedding`.
- **Mongo caído**: picker y replay degradan con aviso accionable (patrón `NO_BACKEND_MESSAGE`, ADR-0052) y el chat arranca fresco; `aitl sessions` sale con mensaje, no con stack trace.
- **Backfill de `title` sobre runs ajenos** (council/host/capturas): `listSessions` solo considera runs CON mensajes y el backfill solo escribe cuando `title` no existe — idempotente y acotado.
- **`onTurn` rompe consumidores existentes**: opcional y observacional puro (como `onTool`); ningún camino del loop depende de su presencia; canario de no-regresión en F4.
- **Rehidratar al reanudar infla tokens del turno**: es UN turno por sesión reanudada, presupuestado por `hydrate()` (best-effort por fuente, lifecycle.ts); `--no-hydrate`/celdas C0 no pasan por el REPL y quedan intactas.

### Dependencias

- **SPEC-02 (tiering)** — blanda: campo opcional `provider.tier` para la status line; sin él se muestra solo el slot. No bloquea ninguna fase.
- **SPEC-09 (telemetry)** — blanda: `estimateCostUsd` para el costo vivo y consumo del evento `resume{bridged}`; import best-effort con degradación a tokens-only. F4 puede aterrizar antes que SPEC-09.
- **SPEC-01 (loops)** — comparte `RunAgentOpts`; `onTurn` le sirve gratis a sus estrategias. Coordinar para no duplicar observadores.
- **SPEC-03 (síntesis)** — el gate de cierre obligatorio debe EXIMIR los turnos de chat con `summarize:false` (chat.ts:474) y contar la sesión de chat como UNA unidad de síntesis al `/exit`; el selector muestra si el run ya tiene síntesis (`summary_slug`). Se acuerda en la fase 1 de SPEC-03.
- **SPEC-06 (multiagent)** — beneficiario: subagentes que reanudan runs heredan la reparación D1 sin trabajo extra.
- ADR-0070 / AACL: sin dependencia.
