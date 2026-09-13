## SPEC-08 — Intercambio de host + hooks de hidratación para otros harnesses
**Requisitos que cubre:** 9 (principal: engancharse a otro harness como hook para hidratar memoria; intercambio Codex/Antigravity/independiente), 7 (no perder contexto entre sesiones cuando el loop NO es del harness), 8 (parcial: subagentes delegables a hosts, junto con SPEC-06). Habilita el 12 (telemetría de runs host, medida en SPEC-09).

### Objetivo y motivación

El harness ya sabe "correr sobre" un host ajeno (Cara B: `runOnHost` envuelve al agente externo con hidratación + run durable + telemetría), pero el intercambio de host es hoy un flag manual por invocación y la integración profunda solo existe para Claude Code (hooks). Esta spec convierte el host en una **dimensión de configuración de primera clase**: (a) `MODEL_HOST` — reservado desde ADR-0020 y hoy sin consumir — pasa a enrutar TODA ejecución; (b) un contrato declarativo `HostIntegration` define, por host, CÓMO se hidrata la memoria hacia dentro y CÓMO se captura la sesión hacia fuera (Claude Code = hooks nativos; Codex = AGENTS.md gestionado + `notify`; Antigravity = adapter de export existente); (c) el orchestrator puede **delegar subagentes a hosts externos**; y (d) el modo independiente (Cara A, el loop propio `runAgent`) queda nombrado como superficie `standalone`, con la misma paridad hidratar/capturar. Resultado: el conocimiento del proyecto viaja con el usuario aunque cambie de harness — el requisito 9 literal.

### Estado actual (anclas de código verificadas)

- `src/hosts/base.ts` — `HOST_SPECS` (líneas 102-121: `claude-code` con `parseClaudeJson` + `writeArgs`/`readonlyArgs`; `codex` = `codex exec -` + `--sandbox read-only`; `antigravity` = `agy run`); interfaz `HostAdapter` (32-35: solo `runTask`); `resolveHostSpec` (226-245, capas args→writeArgs→`AITL_HOST_ARGS_<NAME>`→extraArgs→readonlyArgs AL FINAL, ADR-0055/0058); `getHost` (252); overrides `AITL_HOST_CMD_<NAME>` (`hostEnvKey`, 143).
- `src/hosts/run.ts` — `runOnHost(prompt, project, opts)` (línea 60): hidrata el prompt vía `hydrate()` (101-109), run doc `model: "host:<name>"` + `harness_config.role:"host"` (90-94), modo degradado sin Mongo ADR-0060 (75-87), síntesis de specs `synthesizeSpecRun` (169-190).
- `src/cli.ts` — `run-host` (525-585, flags `--permission-mode/--allowed-tools/--no-hydrate`); `hydrate` (2114-2147, `--no-vector`, `--max-chars` default 4000); `capture-session` (2148-2215, `--source` default `claude-code`, auto-descubre transcript); `orchestrate` (686-704); `init --host` acepta SOLO `claude-code,codex` (validación en 2011); `DEGRADABLE_COMMANDS = new Set(["run-host"])` (49); `aitl build --host "model|claude-code|codex"` para agents (1943).
- `src/config.ts` — `modelHost` zod default `""` (línea 40, comentario 34-35: "planned"); mapeo env `MODEL_HOST` (104); `src/config/store.ts:48` lo lista en `ENV_KEYS`. **Nadie lo lee**: `grep MODEL_HOST src/` = solo esas 2 rutas.
- `src/init/initRepo.ts` — bloque (g) hooks (373-399): claude-code instala `UserPromptSubmit → aitl hydrate --no-vector` y `Stop → aitl capture-session` + `aitl coord poll --quiet`; codex solo imprime "AGENTS.md cubre el contrato" (393-395).
- `src/context/capture.ts` — `captureSession` (312), `parseTranscript` JSONL de Claude Code (122), `findLatestTranscript` en `~/.claude/projects/<cwd>/*.jsonl` (191), `componentTags` (216), guard anti-captura-vacía (turnos==0 && tokens==0 → error, 335-339).
- `src/interactive/taskLogic.ts` — `detectAvailableHosts(env, {specs,isOnPath})` (~80) y `hostOverrideEnvVar` (62): sonda PATH + override, ya pura y testeada.
- `src/orchestration/orchestrator.ts` — `orchestrate()` (66): fan-out `Promise.allSettled` de `runAgent` por subtask (94-107), eventos `spawn` payload `{index, task}` (87-93), `OrchestrateOpts.subAgentOpts` (21-35).
- `src/adapters/antigravity.ts` — `AntigravityAdapter.export()` escribe `GEMINI.md` + `.agent/skills/<name>/SKILL.md`; su header (líneas 9-11) ya anuncia el HostAdapter futuro. `src/adapters/agentsMd.ts` — `AgentsMdAdapter` (AGENTS.md canónico).
- `src/mcpserver/server.ts` — patrón `server.tool` + `runLogged` (311) + `TOOL_RBAC` (241-277, `run_agent: {resource:"memory", action:"create"}` en 276); tool `run_agent` (1224).
- `src/builder/buildDefinition.ts` — los agents del registro ya persisten `metadata.host` (19-20, 70): dato existente sin consumidor.

### Diseño

#### D1. Router de superficie de ejecución (consume `MODEL_HOST`)

Nuevo `src/hosts/router.ts`, funciones puras:

```ts
export type ExecutionSurface = { kind: "standalone" } | { kind: "host"; host: string };
export function resolveExecutionSurface(opts: {
  flagHost?: string;            // --host <name|none> del CLI
  modelHost?: string;           // settings.modelHost (config.ts:40)
  known?: string[];             // default Object.keys(HOST_SPECS)
}): ExecutionSurface;           // precedencia: flag ("none" ⇒ standalone) > MODEL_HOST > standalone
```

Consumo en la acción de `aitl run` (cli.ts, junto al manejo de `--bare` ~283): si la superficie es `host`, la acción llama `runOnHost` en vez de `runAgent`, mapeando `--no-hydrate → hydrate:false` y `--project` tal cual. Flags exclusivos del loop (`--verify-cmd`, `--loop-spec`, `--budget-*`, `--max-iters`, `--stream`, `--ask`, `--roles`) con superficie host ⇒ **error accionable** ("estos flags son del loop propio; quita --host o usa aitl run --host none"), nunca silencio. `aitl run --bare --host X` sí es válido (C0 sobre host = `hydrate:false`, paridad con `run-host --no-hydrate`, ADR-0068). `run-host` queda como alias explícito estable (compatibilidad; los scripts del lab raytracer lo usan).

#### D2. Contrato `HostIntegration` — hidratar/capturar en harnesses ajenos

Nuevo `src/hosts/integration.ts`. Declara por host los DOS sentidos del conocimiento:

```ts
export type HydrationMode = "hook" | "file" | "prompt";   // hook nativo | archivo gestionado | prepend en runOnHost
export type CaptureMode  = "hook" | "notify" | "wrap";    // hook Stop | notify del host | envoltura runOnHost

export interface TranscriptParser {
  id: string;                                             // "claude-jsonl" | "codex-jsonl"
  discover(cwd?: string): Promise<string | null>;
  parse(path: string): Promise<ParsedTranscript>;         // tipo existente, capture.ts:48
}

export interface HostIntegration {
  host: string;                                           // clave de HOST_SPECS, o "standalone"
  hydration: { mode: HydrationMode; install?: (root: string, project: string) => Promise<InitStep[]> };
  capture:   { mode: CaptureMode;  parser?: TranscriptParser; install?: (root: string, project: string) => Promise<InitStep[]> };
}
export const HOST_INTEGRATIONS: Record<string, HostIntegration>;
```

Matriz v1 (cada celda con instalador idempotente estilo `[ok|skip|done]` de `aitl init`):

| host | hydration | capture | parser |
|---|---|---|---|
| `standalone` | `prompt` (el propio `hydrate()` del loop, graph.ts) | `wrap` (`summarizeSession` al cierre) | — |
| `claude-code` | `hook` UserPromptSubmit (hoy en initRepo.ts:376-380, se MUEVE aquí sin cambiar bytes) | `hook` Stop (capture-session + coord poll) | `claude-jsonl` (el `parseTranscript` actual, extraído) |
| `codex` | `file`: bloque gestionado en `AGENTS.md` (D3) | `notify` (D4) | `codex-jsonl` (D4) |
| `antigravity` | `file`: `GEMINI.md` + `.agent/skills/` vía `AntigravityAdapter` existente | `wrap` v1 (solo vía `runOnHost`; poll de transcript DIFERIDO) | — |

Refactor aditivo: el bloque (g) de `initRepo.ts` delega en `HOST_INTEGRATIONS[h].hydration.install / capture.install`; la validación de `aitl init --host` (cli.ts:2011) pasa a aceptar `antigravity`. `captureSession` resuelve el parser por `opts.source` (`parserFor(source)` en integration.ts); `parseTranscript`/`findLatestTranscript` actuales se convierten en el parser `claude-jsonl` sin cambiar su comportamiento (tests existentes de `capture.test.ts` siguen verdes).

#### D3. Hidratación por archivo gestionado — el "hook" universal

Para harnesses SIN sistema de hooks (Codex, y cualquier futuro lector de AGENTS.md), la hidratación es un bloque marcado dentro del archivo que el host ya lee:

```
aitl hydrate --project aitl-js --into AGENTS.md [--max-chars 4000]
```

Nuevo `src/hosts/hydrateFile.ts`: `upsertHydrationBlock(content: string, block: string, project: string): { content: string; changed: boolean }` — puro, inserta/reemplaza entre `<!-- aitl:hydrate:begin project=aitl-js -->` y `<!-- aitl:hydrate:end -->` (al final del archivo si no existe), estable byte a byte cuando el preámbulo no cambió (mismo espíritu que `writeIfChanged` de sync/export.ts). El presupuesto reutiliza `--max-chars` (cli.ts:2123) para no inflar la ventana del host. Se refresca en 3 momentos: `aitl init`, el hook git `post-merge` ya instalado (initRepo.ts, bloque (h)) y cada captura por notify (D4) — hidratación cuasi-continua sin hooks. Igual para `GEMINI.md` (`--into GEMINI.md`).

#### D4. Codex: captura vía `notify` + parser de rollouts

- **Parser** `src/hosts/parsers/codexJsonl.ts` (`id: "codex-jsonl"`): lee los rollouts de sesión de Codex CLI (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`: `session_meta` con `cwd`, ítems user/assistant, recuentos de tokens cuando la versión los emite) → `ParsedTranscript`. Formato de tercero: se fija con **fixtures golden** en `src/hosts/parsers/fixtures/` verificados contra la versión instalada en F3; si no hay recuento de tokens, `usage` queda en ceros y la guard anti-vacío pasa por `turns > 0` (capture.ts:335 exige AMBOS en cero para fallar).
- **Dispatcher** `aitl host-notify codex` (nuevo comando; entra en `DEGRADABLE_COMMANDS`, cli.ts:49; contrato de hook: stderr + exit 0 SIEMPRE): recibe el JSON que Codex pasa como último argv en `agent-turn-complete`; descubre el rollout más reciente; resuelve el project por el `cwd` del `session_meta` con `resolveProject` (marcador `.aitl/project.json`, ADR-0063) — si el cwd no pertenece a un repo inicializado, sale en silencio (el notify de Codex es global por usuario). Luego: `captureSession({source:"codex", transcriptPath, cwd})` + refresco del bloque D3 + evento `coord_events` best-effort (mismo bus que `publish_event`).
- **Instalador** (`capture.install` de codex, corre en `aitl init --host codex`): escribe `.aitl/hooks/codex-notify.sh` (wrapper de una línea a `aitl host-notify codex "$@"`) y hace merge conservador de `notify = ["bash", "<ruta absoluta>"]` en `~/.codex/config.toml` con comentario marcador `# aitl:notify`; si existe un `notify` ajeno NO lo pisa: `[warn]` con instrucciones manuales. Desinstalación documentada en docs/HOSTS.md.
- **Dedupe**: antes de crear el run, `captureSession` consulta `RunModel` por `harness_config.session_file` (nuevo campo opcional = ruta+mtime del transcript; `run.model.ts` es `strict:false`, línea 49) y hace skip si esa versión ya se capturó — el notify dispara por turno, no por sesión.

#### D5. Delegación de subagentes a hosts (orchestrator)

Extensión aditiva de `OrchestrateOpts` (orchestrator.ts:21):

```ts
delegate?: {
  host: string;                      // clave de HOST_SPECS
  match?: RegExp;                    // solo subtasks que matchean; sin match ⇒ todas
  cwd?: string;                      // con SPEC-06: el worktree del subagente
  timeoutMs?: number;                // default AITL_HOST_TIMEOUT_MS
  hostArgs?: string[];               // p.ej. --allowedTools "Bash(npm:*)"
};
```

En el fan-out (orchestrator.ts:94-107): por subtask, `pickSurface(task, delegate, agentMeta)` decide `runAgent` (hoy) o `runOnHost(task, project, { host, cwd, timeoutMs, hostArgs, parentRunId: runId })`. Regla de ruteo (precedencia): `delegate` del caller > `metadata.host` del agent definition invocado (buildDefinition.ts:19-20 — el dato por fin se consume) > standalone. `RunOnHostOpts` gana `parentRunId?: string` → `harness_config.parent_run_id` en el run hijo (forense de SPEC-09). El evento `spawn` (orchestrator.ts:87-93) enriquece su payload a `{index, task, surface: "standalone" | "host:<name>"}`. El solo-lectura del council no se toca: `readonlyArgs` sigue aplicándose AL FINAL (base.ts:242, ADR-0055). CLI: `aitl orchestrate --delegate <host> [--delegate-match <regex>] [--delegate-timeout <ms>]`.

#### D6. Tools MCP nuevas

- `list_hosts` — solo lectura, SIN entrada en `TOOL_RBAC` (como `poll_events`): `{}` → `{ active: string, hosts: [{name, available, via, command, hydration, capture}] }` usando `detectAvailableHosts` (taskLogic.ts) + `HOST_INTEGRATIONS` + `settings.modelHost`.
- `run_host` — schema zod: `{ project: z.string(), task: z.string(), host: z.string().describe("claude-code | codex | antigravity"), cwd: z.string().optional(), timeout_ms: z.number().int().positive().default(600_000), hydrate: z.boolean().default(true), permission_mode: z.string().optional(), allowed_tools: z.string().optional(), parent_run_id: z.string().optional() }` → `runLogged("run_host", …)` → `runOnHost`. RBAC: `run_host: { resource: "memory", action: "create" }` (mismo catch-all que `run_agent`, server.ts:276) + canario en `mcpserver/rbac.test.ts`. Con esto cualquier agente conectado al MCP (incluido OTRO harness) delega trabajo a un host y la corrida queda en el ledger de runs.

#### D7. CLI, config y ejemplos

```
aitl hosts list [--json]     # disponibilidad (path|override), comando efectivo, modos hydrate/capture, superficie activa
aitl hosts check [name]      # prueba viva readonly ("responde con OK") con timeout; reporta si el parse de tokens funcionó
aitl hosts use <name|none>   # persiste MODEL_HOST vía config + espejo .env (src/config/envfile.ts, ADR-0050)
aitl host-notify <host>      # dispatcher de notify (D4); degradable, jamás rompe la sesión del usuario
aitl hydrate --into <file>   # bloque gestionado (D3)
```

Env: `MODEL_HOST` (existente, AHORA consumido; `""` = standalone) y nueva `AITL_HOST_TIMEOUT_MS` (default 600000) añadida a `ENV_KEYS` (config/store.ts:42), `.env.example` y la ConfigView web (las 35→36 claves de ADR-0061). Perfil de ejemplo (`~/.aitl/profiles/campana-codex.json`, ADR-0061): `{ "MODEL_HOST": "codex", "AITL_HOST_ARGS_CODEX": "--sandbox workspace-write" }` — cambiar de harness completo = `AITL_PROFILE=campana-codex`.

**Flujo A (intercambio de host):** `aitl hosts use codex` → todo `aitl run` corre sobre Codex con hidratación previa y captura al cierre; `aitl run --host none "…"` fuerza Cara A puntual sin tocar config. **Flujo B (hook en harness ajeno, requisito 9 literal):** el usuario trabaja EN Codex a mano; cada fin de turno el notify captura la sesión a la memoria aitl-js y refresca el bloque de AGENTS.md → la siguiente sesión, en CUALQUIER host, arranca hidratada. **Flujo C (delegación):** el orquestador (tier design, SPEC-02) planifica; las subtasks marcadas van a claude-code con `parent_run_id`; el resto al loop propio.

### Fases de implementación

- **F1 — Router + `aitl hosts`**: `src/hosts/router.ts` (+ test puro de precedencia flag>env>default y de rechazo de flags de loop), consumo en `aitl run`, comandos `hosts list|check|use`. Verificación: `npm run verify`; E2E con host fake: `AITL_HOST_CMD_CLAUDE_CODE=./fake.sh MODEL_HOST=claude-code aitl run "ping" --project aitl-js` → run doc `model=host:claude-code`; `aitl hosts use none` restaura y `aitl run` vuelve al loop.
- **F2 — Contrato HostIntegration + archivo gestionado + antigravity en init**: `integration.ts` (matriz D2), refactor del bloque (g) de initRepo SIN cambio de bytes para claude-code (test golden del settings.json emitido), `hydrateFile.ts` puro con tests de idempotencia, fix de la validación (cli.ts:2011). Verificación: `aitl init --host antigravity` en repo tmp = `[done]` la 1ª vez, `[skip]` la 2ª; `aitl hydrate --into AGENTS.md` dos veces seguidas = sin diff.
- **F3 — Codex end-to-end**: parser `codex-jsonl` + fixtures golden (verificados contra la versión instalada de Codex), `aitl host-notify codex`, instalador notify con merge conservador de `config.toml`, dedupe por `session_file`. Verificación: `node --test` sobre fixtures; E2E vivo (si `codex` está en PATH): sesión corta `codex exec`, luego `aitl capture-session --source codex` → run con `turns>0` y memoria escrita; segunda captura de la misma sesión = skip.
- **F4 — Delegación + MCP**: `OrchestrateOpts.delegate` + `parentRunId` + `spawn.surface` + tools `run_host`/`list_hosts` + canario RBAC. Verificación: E2E `aitl orchestrate --delegate claude-code` con host fake → N runs hijos con `harness_config.parent_run_id` = run maestro; `mcpserver/rbac.test.ts` verde; llamada `run_host` viva tras reiniciar el server MCP.
- **F5 — Guía y paridad**: `docs/HOSTS.md` (matriz D2 con un comando copiable por celda, recetas por host, desinstalación del notify), `addHelpText` de los comandos nuevos, actualización de docs/ARQUITECTURA.md. Verificación: `npm run verify` + repaso de que cada celda de la matriz tiene su comando probado en F1-F4.

### ADRs a registrar

- «MODEL_HOST consumido: router de superficie de ejecución (standalone | host) con precedencia flag > perfil > default» — status: proposed.
- «Contrato HostIntegration: hidratación y captura declarativas por host (hook | archivo gestionado | notify | wrap)» — status: proposed.
- «Captura de sesiones Codex vía notify global filtrado por marcador de proyecto + parser de rollouts con fixtures golden» — status: proposed.
- «Delegación de subagentes a hosts externos con parent_run_id en el ledger de runs» — status: proposed.

### Medición para la tesis

La Cara B ya es medible (tokens/costo/turnos del host, ADR-0034; métrica #7 de `tab:metrics`). Lo nuevo: (a) **condición exploratoria de portabilidad** `c2-host-codex` — la misma fase del lab raytracer, misma memoria durable, host Codex en lugar de Claude Code (n=1 exploratoria, análoga a `c2-sonnet-spec` del cap. 5): aísla el factor *Host* de la fórmula Evento+Meta+Modelo+Harness+Loop+Humano; (b) **métrica de paridad de captura**: artefactos durables escritos por sesión (ADRs/memorias/snapshot, ya contados por `SessionArtifacts`) comparados entre claude-code/codex/standalone — si la captura por notify rinde ≥ la de hooks, el requisito 9 queda demostrado empíricamente. La **delegación multi-host (D5) entra como capacidad sin compromiso evaluativo**: "sistema multiagente complejo" está fuera de alcance en cap. 1; si SPEC-10 amplía la delimitación, se promueve a celda.

### Riesgos y mitigaciones

- **`notify` de Codex es global por usuario** (un solo `config.toml`): el dispatcher filtra por marcador `.aitl/project.json` del `cwd` de la sesión y sale en silencio fuera de repos inicializados; el instalador nunca pisa un notify ajeno (warn + receta manual).
- **Formatos de transcript de terceros cambian sin aviso**: parsers best-effort con fixtures golden por versión; la guard anti-captura-vacía existente (capture.ts:335) impide registrar basura; fallo de parse = stderr + exit 0 (contrato de hook).
- **Ambigüedad de semántica en `aitl run --host`**: flags del loop rechazados con error accionable (D1), nunca ignorados — evita "creí que verify corría y no corrió".
- **Captura doble** (sesión delegada por `runOnHost` Y capturada por el Stop hook del repo destino): dedupe por `harness_config.session_file` + `meta.session_id` de `parseClaudeJson` (base.ts:93) ya persistido en `host_meta`.
- **Antigravity sin salida estructurada** (`agy run` sin JSON conocido): tokens en ceros como hoy; se declara `capture: wrap` v1 y la limitación queda explícita en docs/HOSTS.md — no se promete lo que no se mide.
- **Crecimiento del bloque gestionado en AGENTS.md**: presupuesto `--max-chars` (default 4000) y bloque único reemplazado, nunca acumulado.

### Dependencias

- **SPEC-02 (tiering)**: el router de tiers trata `host:*` como opaco (un host no es un provider); el orquestador con tier design decide QUÉ delegar.
- **SPEC-03 (síntesis)**: el gate determinista "no hay done sin memoria" aplica también a runs host — `captureSession`/`runOnHost` son los puntos de escritura; la captura-que-sintetiza de SPEC-03 sustituye el truncado dentro de `summarizeSession` sin tocar este contrato.
- **SPEC-06 (multiagent/worktrees)**: `delegate.cwd` default = worktree del subagente; el enriquecimiento de eventos `spawn` es compartido (un solo shape).
- **SPEC-04 (CLI)**: el selector de sesiones lista también runs `model: host:*`.
- **SPEC-09 (telemetry)**: consume `parent_run_id`, `host_meta.cost_usd` y los runs de captura para el forense por sesión y el costo por modelo.
- **AACL (por referencia, ADR proposed)**: `host-notify` publica en `coord_events` (bus pull existente); cuando AACL aterrice su canal push SSE/WS, las capturas de hosts ajenos se vuelven notificaciones en vivo sin cambiar esta spec.
