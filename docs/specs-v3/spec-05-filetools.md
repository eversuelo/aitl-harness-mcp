## SPEC-05 — Tools de archivos ampliadas + toolsets por perfil/modelo + carga diferida de schemas
**Requisitos que cubre:** 3 (más tools para escribir en archivos); habilita el 1 (harness tipo claude-code), el 6 y el 16 (modelos pequeños/baratos solo son viables si no reciben 58 schemas) y el 12 (overhead de esquemas medido por modelo); prepara el 17 (SPEC-12 registra `view_image` como una tool más del toolset).

### Objetivo y motivación
El loop opera hoy con 4 tools de archivos/shell y compensa el resto con `shell` (cat, grep, mv…), lo que cuesta iteraciones y ensucia el transcript. Pero crecer la superficie tiene costo directo: el loop envía TODOS los esquemas al provider en cada turno, y la tesis constata que ~80% de la ventana de un 7B se va en esquemas de tools. Esta spec entrega las dos mitades como una sola pieza: (a) suite de tools de archivos de primera clase (rangos de lectura, multi-edición atómica, parches unified, glob/grep, mkdir/mv/rm gateados) con confinamiento real a un workspace root; y (b) su antídoto: **toolsets versionados por content-hash** elegidos por perfil/tier/modelo, **carga diferida** vía meta-tool `tool_search` (el modelo descubre y activa tools que no recibió en el contrato inicial) y telemetría del costo de esquemas por run para que la tesis lo mida.

### Estado actual (anclas de código verificadas)
- **Tools del loop** en `src/tools/`: `read_file` (filesystem.ts:7-19) lee el archivo ENTERO — sin rangos ni tope, un archivo grande entra completo al contexto; `write_file` (filesystem.ts:21-39) **YA EXISTE** — el «write_file» del alcance está cubierto, NO se duplica; `edit_file` (filesystem.ts:41-82, ADR-0064) reemplazo exacto único con `replace_all`; `shell` (shell.ts:21-46) con `clip()` head+tail a `MAX_RESULT_CHARS = 30_000` (shell.ts:13-19) — patrón a reutilizar. El header de filesystem.ts dice "within a workspace root" pero **no se enforcea**: cualquier ruta absoluta pasa.
- **Registry y despacho**: interfaz `Tool` con `inputSchema` JSON-schema plano y `requiresApproval` (base.ts:10-18); `ToolRegistry.schemas()` devuelve TODO sin filtro (base.ts:104-106); `call()` con gates → pre-hooks → run → post-hooks (base.ts:118-161); `unregister()` existe (base.ts:83-85). El loop re-lee `registry.schemas()` **cada iteración** (`src/orchestration/graph.ts:568-571`) → la activación en caliente ya es viable sin tocar el loop (mismo mecanismo que documenta `mcp_add`, chat.ts:157-159).
- **Registro de defaults**: `runAgent` `installDefaultTools` (graph.ts:241-245), `aitl chat` (src/repl/chat.ts:152-157) y el orchestrator (`src/orchestration/orchestrator.ts:103`, un `ToolRegistry` fresco por subagente). El cliente MCP monta TODO lo remoto como `mcp__<server>__<tool>` sin filtro (`mountMcpTools`, src/mcpclient/client.ts:109; `McpManager.mount` en vivo, manager.ts).
- **Gates**: `denyPathsGate` **hardcodea** `write_file|edit_file|shell` (src/hooks/gates.ts:20-33, l. 22) y `adrGuard` hardcodea `GUARDED_TOOLS = {write_file, edit_file, shell}` (src/hooks/adrGuard.ts:109) → toda tool de escritura nueva quedaría FUERA de la política si no se generaliza. Aprobación humana: `approvalGate` lee `requiresApproval` vía `registry.get` (src/hooks/approval.ts:52-58; instalación idempotente l. 110-125).
- **Patrón de spec versionada a clonar**: `LoopSpecSchema` zod `.strict()` + `loopSpecVersion` content-hash sha256[:12] + `loadLoopSpecAuto` (archivo o colección `loops`) en `src/orchestration/loopspec.ts:18-99`; persistencia por `DefinitionStore` con `DefinitionKind = "agent" | "skill" | "loop"` (`src/models/definition.model.ts:26-29`, `collectionFor`/`modelFor` l. 62-63).
- **Walker con .gitignore ya escrito pero privado**: `loadIgnore` (matcher `ignore()`) + `walkDir` (baseline `.git`/`node_modules`) en `src/repomap/parser.ts:395-427`. `globMatch` simple en gates.ts:12-17.
- **Medición y estampado**: heurística ~4 chars/token (`ContextManager.estimate`, src/context/manager.ts:25-28; `estimateTokens`, src/providers/base.ts:65-68); `ProviderCapabilities.maxContext` (src/contracts.ts:56-63); `harness_config` es `Schema.Types.Mixed` (src/models/run.model.ts:42) → estampar `toolset@version` es aditivo sin migración. `ENV_KEYS` editable en src/config/store.ts:42-80. Tool MCP `run_agent` (src/mcpserver/server.ts:1224+) no expone selección de toolset; `TOOL_RBAC` (server.ts:241-277) con canario en `mcpserver/rbac.test.ts`. **`rg` NO está en el PATH de la máquina actual** (verificado 2026-07-17) → la detección debe ser runtime con fallback JS.

### Diseño

#### D1. Nuevas tools de archivos (`src/tools/fsx.ts`, una clase por tool)
Todas devuelven string (convención del registry) y clipean a 30 000 chars (extraer `clip()` de shell.ts:15-19 a `src/tools/clip.ts`; shell.ts lo re-importa). Escritoras con `requiresApproval: true` (cubiertas por `--ask`, ADR-0040). Rutas relativas se resuelven contra un `Workspace` inyectado por constructor (D2).

| Tool | inputSchema (JSON-schema plano, como filesystem.ts) | Semántica |
|---|---|---|
| `read_file` (ampliación in-place en filesystem.ts) | `+ offset?: integer, limit?: integer, line_numbers?: boolean` | Rango 1-based; salida `NNN→` por línea cuando se pide rango (ancla para edit_file); clip con aviso `[truncado N chars — usa offset/limit]`. Sin args nuevos = comportamiento actual + clip (retrocompatible). |
| `multi_edit` | `{ path, edits: [{ old_string, new_string, replace_all? }] }`, required `[path, edits]` | N sustituciones **atómicas**: se validan TODAS en memoria (en orden, cada una sobre el resultado de la anterior; misma semántica de unicidad que EditFileTool filesystem.ts:64-75) y se escribe UNA vez; si la edición k falla, no se escribe nada y el error nombra el índice (`edit 3/5: old_string not found`). |
| `apply_patch` | `{ patch: string, strip?: integer (default 1) }` | Unified diff **multi-archivo** (parser TS puro `src/tools/patch.ts`: `parseUnifiedPatch(patch): FilePatch[]` + `applyHunks(content, hunks)`); soporta crear (`--- /dev/null`) y borrar (`+++ /dev/null`); match de contexto exacto con búsqueda de desplazamiento ±20 líneas (fuzz de posición, nunca de contenido); en fallo, error con archivo+hunk exactos y el consejo «usa multi_edit». Sin `git apply` (funciona fuera de repos). La descripción dirige: «prefiere edit_file/multi_edit; apply_patch solo para diffs multi-archivo». |
| `glob` | `{ pattern, dir?, limit? (default 200) }` | Rutas relativas ordenadas por mtime desc. Reutiliza el walker de repomap: extraer `loadIgnore`/`walkDir` (parser.ts:395-427) a `src/util/fswalk.ts` exportado (parser.ts re-importa; cero duplicación) + `globMatch` de gates.ts generalizado a `**`. |
| `grep` | `{ pattern, dir?, glob?, ignore_case?, max_results? (50), context? (0-5) }` | Regex sobre el workspace. Con ripgrep (sonda `execFile("rg",["--version"])` cacheada en módulo; override `AITL_NO_RG=1`): `rg -n --no-heading -S -m <max>`; sin él, fallback JS sobre `fswalk` (skip binarios por byte NUL). Salida `ruta:línea:texto`, clip 30 000. |
| `mkdir` | `{ path }` | `fs.mkdir(recursive: true)` — idempotente. |
| `move_path` | `{ from, to, overwrite? (false) }` | `fs.rename` con fallback copy+unlink cross-device; destino existente sin `overwrite` = error. |
| `remove_path` | `{ path, recursive? (false) }` | `fs.rm`; borrar directorio exige `recursive: true` explícito; **nunca** sigue symlinks (`lstat` primero); rehúsa el root del workspace. |

#### D2. Declaración única de superficie de rutas + workspace root
Nuevo `src/tools/paths.ts` — una sola fuente de verdad que gates y hooks consumen:
```ts
export interface Workspace { root: string }  // default process.cwd(); SPEC-06 lo apunta al worktree
/** name → extractor de rutas que la tool LEE o ESCRIBE ([] = no toca rutas). */
export const PATH_ARGS: Record<string, (args: Record<string, unknown>) => string[]> = {
  read_file: (a) => [String(a.path)], glob: (a) => [String(a.dir ?? ".")], grep: (a) => [String(a.dir ?? ".")],
  write_file: (a) => [String(a.path)], edit_file: (a) => [String(a.path)], multi_edit: (a) => [String(a.path)],
  apply_patch: (a) => patchTargets(String(a.patch)), mkdir: (a) => [String(a.path)],
  move_path: (a) => [String(a.from), String(a.to)], remove_path: (a) => [String(a.path)],
};
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file", "edit_file", "multi_edit", "apply_patch", "mkdir", "move_path", "remove_path",
]);
```
- `denyPathsGate` (gates.ts:20-33) se reescribe para iterar `PATH_ARGS[name]` cuando `WRITE_TOOLS.has(name)` (+ el caso especial `shell` sobre `args.command`, como hoy): una tool nueva se protege agregando UNA entrada, no tocando el gate. Los patrones default (`.git/*`, `*.env`, `*.pem`, `*id_rsa*`, gates.ts:60) cubren automáticamente `remove_path`/`move_path`.
- `adrGuard`: `GUARDED_TOOLS` (adrGuard.ts:109) pasa a `new Set([...WRITE_TOOLS, "shell"])` — las ediciones por `multi_edit`/`apply_patch` también reciben la anotación de ADRs por `components[]`.
- **`workspaceGate(root)`** nuevo en gates.ts: resuelve cada ruta de `PATH_ARGS` (`path.resolve` + `realpath` del padre existente) y deniega si `relative(root, p)` empieza con `..`. Se instala cuando llega el nuevo `RunAgentOpts.workspaceRoot?: string` (junto al bloque de gates, graph.ts:247-249). Las tools reciben el mismo `Workspace` por constructor para resolver rutas RELATIVAS contra el root (parámetro opcional: sin él, comportamiento actual intacto).

#### D3. Toolsets versionados (patrón LoopSpec calcado)
Nuevo `src/tools/toolset.ts`:
```ts
export const ToolsetSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  include: z.array(z.string()).min(1),   // nombres o globs: "read_file", "mcp__github__*", "*"
  exclude: z.array(z.string()).optional(),
  defer: z.array(z.string()).optional(), // registradas pero SIN schema hasta activarse (D4)
  maxActive: z.number().int().positive().optional(), // tope de activaciones vía tool_search (default 10)
}).strict();
export type ToolsetSpec = z.infer<typeof ToolsetSpecSchema>;
export function toolsetVersion(spec: ToolsetSpec): string;          // content-hash sha256[:12], calca loopSpecVersion
export async function loadToolsetAuto(project: string, nameOrPath: string): Promise<{ spec: ToolsetSpec; ref: ToolsetRef }>;
// resolución: builtin → archivo .json si es path-like → colección `toolsets`; calca loadLoopSpecAuto (loopspec.ts:79-87)
```
- **Persistencia**: `DefinitionKind` gana `"toolset"` → `TOOLSETS_COLLECTION = "toolsets"` + `ToolsetModel` (cambios aditivos en el union y en `collectionFor`/`modelFor`, definition.model.ts:26-29 y 62-63). Espejo a disco por `aitl sync` en `.aitl/toolsets/*.json` (misma mecánica ADR-0051).
- **Builtins** (`BUILTIN_TOOLSETS` en toolset.ts): `full` (todo — default, byte-compatible con hoy), `core` (read_file, edit_file, write_file, shell), `fs` (core + multi_edit, apply_patch, glob, grep, mkdir, move_path, remove_path), `readonly` (read_file, glob, grep), `mini` (read_file, edit_file, shell, tool_search; `defer: ["*"]` para el resto) — pensado para ≤32k de contexto.
- **Vista sobre el registry**: `ToolRegistry.schemas(view?: ToolsetView)` — sin argumento conserva el output actual byte a byte (ningún caller se rompe). `ToolsetView` (toolset.ts) guarda `{ active: Set<string>, deferred: Map<string, Tool>, activate(names: string[]): string[] }` y vive en el estado del run dentro de `runAgent` — dos runs concurrentes no comparten activaciones. Los gates NO se filtran: una tool fuera del toolset ni siquiera tiene schema, y si el modelo la alucina, `call()` responde `[error] unknown tool` como hoy (base.ts:132-133).
- **Precedencia** (función pura `resolveToolset()`, mismo estilo que `resolveLoopPolicy` loopspec.ts:138-153): `RunAgentOpts.toolset` (flag) > `LoopSpec.toolset` (campo nuevo `toolset: z.string().optional()` en LoopSpecSchema loopspec.ts:18-40 — coordinado con SPEC-01) > binding modelo→toolset (hook que SPEC-11 llenará; hoy devuelve null) > env `AITL_TOOLSET` (entra a `ENV_KEYS` config/store.ts:42, configurable por perfil ADR-0061) > heurística: `provider.capabilities().maxContext > 0 && < 32_000` → `mini` con evento warning > `full`.

#### D4. Carga diferida: `tool_search`
Nuevo `src/tools/toolsearch.ts` — meta-tool presente siempre que el view tenga diferidas:
```ts
// name: "tool_search"; inputSchema: { query: string, max_results?: integer (default 5) }
// Busca lexical (name + description, scoring por término) sobre las diferidas del ToolsetView,
// las ACTIVA (view.activate, respetando maxActive) y devuelve sus schemas como texto JSON.
// El loop ya re-lee schemas(view) cada turno (graph.ts:568-571) → usables desde el turno siguiente.
```
- El system prompt recibe un bloque presupuestado «Tools diferidas (actívalas con tool_search): `name — descripción 1 línea`» (~40 chars/tool: 40 tools ≈ 400 tokens vs ~6-8k de sus schemas completos).
- **MCP diferido**: `MountMcpOpts` (mcpclient/client.ts:35-43) gana `defer?: boolean`; cuando el toolset activo matchea `defer: ["mcp__*"]`, `mountMcpTools` y `mcp_add` (chat.ts:161-186) registran las tools remotas directo como diferidas — montar un server de 30 tools deja de costar 30 schemas.
- Auditoría: evento `tool_activation { query, activated: string[], schema_tokens_added }` por cada activación.

#### D5. Telemetría del costo de esquemas
- `schemaTokens(schemas) = Math.ceil(JSON.stringify(schemas).length / 4)` (misma heurística que `ContextManager.estimate`, manager.ts:25-28) en toolset.ts.
- `runAgent` estampa en `harness_config` (Mixed, run.model.ts:42 — donde ya va `loop_spec@version`, ADR-0062): `toolset: { name, version, tools_active, tools_deferred, schema_tokens }` + evento `toolset_route` al inicio. SPEC-09 suma estos campos a sus reportes de costo por modelo.

#### D6. CLI y config
- `aitl tools [--toolset <n>] [--json]` — tabla: nombre · activa/diferida · schema-tokens · requiresApproval · origen (builtin/mcp).
- `aitl toolset {list, show <n>, init <n> [--from fs], push <file.json>}` — `init` escribe `.aitl/toolsets/<n>.json`; `push` lo sube a la colección (calca los subcomandos de loop-spec en cli.ts).
- `aitl run --toolset <nameOrPath>` (junto a `--loop-spec`, cli.ts:188) y `aitl orchestrate --toolset` (vía `subAgentOpts`, cli.ts:698).
- `aitl chat`: slash `/toolset [name]` (sin arg: activo + conteo activas/diferidas + schema-tokens); el statusline de SPEC-04 muestra `toolset@version`.
- Env: `AITL_TOOLSET` en `ENV_KEYS` → aparece gratis en la pestaña Config de la web y en perfiles.

#### D7. Superficie MCP
- `run_agent` (server.ts:1224+) gana `toolset: z.string().optional()` en su schema zod.
- Tool nueva `write_toolset` — zod `{ project: z.string(), name: z.string(), include: z.array(z.string()).min(1), exclude: z.array(z.string()).optional(), defer: z.array(z.string()).optional(), description: z.string().optional() }` → `saveToolset`; envuelta en `runLogged`, entrada `write_toolset: { resource: "agents_skills", action: "create" }` en `TOOL_RBAC` (server.ts:241-277) + canario en rbac.test.ts.
- Tool nueva `list_toolsets` `{ project }` read-only (sin entrada RBAC, como las demás lecturas).

### Fases de implementación
- **F1 — Lectura y búsqueda**: `read_file` con rangos+clip, `glob`, `grep` (rg + fallback), extracción de `src/util/fswalk.ts` y `src/tools/clip.ts`. Verificación: `npm run verify` verde; `src/tools/fsx.test.ts` (~15 casos: rango 1-based, clip con aviso, `.gitignore` respetado, fallback forzado con `AITL_NO_RG=1`); E2E: `aitl run "¿cuántos TODO hay en src/? responde solo el número" --verify-cmd true` usa `grep` en el transcript.
- **F2 — Escritura y gates**: `multi_edit`, `apply_patch` + `patch.ts`, `mkdir`/`move_path`/`remove_path`; `paths.ts` + reescritura de `denyPathsGate`/`adrGuard` sobre `PATH_ARGS`/`WRITE_TOOLS` + `workspaceGate` + `RunAgentOpts.workspaceRoot`. Verificación: tests de atomicidad (edit 3/5 falla ⇒ archivo intacto), golden tests de patch (multi-archivo, creación, borrado, hunk desplazado ±20), `remove_path` de `*.env` denegado (canario del gate generalizado), escape del workspaceRoot denegado; `npm run verify`.
- **F3 — Toolsets**: `toolset.ts` (schema, version, builtins, `resolveToolset`), kind `"toolset"` en definition.model.ts, `LoopSpec.toolset`, `schemas(view)`, estampa en `harness_config` + evento `toolset_route`, CLI `aitl tools`/`aitl toolset`/`--toolset`, `/toolset` en chat, `AITL_TOOLSET` en ENV_KEYS. Verificación: tests de precedencia (flag > spec > env > heurística), hash estable ante reorden de claves, snapshot de que `schemas()` sin view es idéntico a hoy; E2E: `aitl run --toolset readonly` no puede escribir (schema ausente + `unknown tool` si alucina).
- **F4 — Diferido + MCP + docs**: `tool_search` + `ToolsetView.activate` + bloque de diferidas en system prompt + `MountMcpOpts.defer` + evento `tool_activation` + `run_agent.toolset` + `write_toolset`/`list_toolsets` + canario RBAC + guía `docs/TOOLS.md` (inventario, costo de esquemas por toolset, recetas por tamaño de modelo). Verificación: `npm run verify`; E2E vivo: chat con toolset `mini` y un server MCP montado diferido — pedir una operación que exige una tool diferida, ver `tool_activation` en eventos y la tool usable al turno siguiente.

### ADRs a registrar
- «Superficie de tools de archivos v2: multi_edit atómico, apply_patch unified, glob/grep, rangos de lectura, y declaración única PATH_ARGS/WRITE_TOOLS para gates y adrGuard» — status: proposed al abrir, accepted al cerrar F2.
- «Toolsets versionados por perfil/modelo y carga diferida de schemas vía tool_search» — status: proposed; consecuencias con deuda explícita: el binding modelo→toolset queda como hook nulo hasta SPEC-11; la heurística por maxContext es un default conservador, no un catálogo.

### Medición para la tesis
- **Métrica nueva** `schema_tokens` (y derivada `schema_overhead = schema_tokens / maxContext`) por run, exportada a `tab:metrics` vía SPEC-10 — convierte en medible la afirmación del cap. 3 sobre el costo del contrato de tools.
- **Condición nueva**: celda con modelo pequeño (slot openai-compat/Chutes, 7-8B) × {toolset `full`, toolset `mini`} sobre una fase del raytracer: tasa de tool-calls malformados, `stop_reason`, verify-pass y costo_pond. Hipótesis operativa: `mini` reduce el overhead >60% sin degradar el verify-pass del modelo pequeño.
- Las tools de archivos en sí son **capacidad del artefacto sin compromiso evaluativo** (precedente: roles H11 degradado): entran a la bitácora IMPL, no generan celda propia — la celda la genera el toolset, que sí cambia el resultado.

### Riesgos y mitigaciones
- **La indirección `tool_search` confunde a modelos chicos** (justo su público): los toolsets estáticos (`mini`, `readonly`, `fs`) funcionan SIN diferido; `defer` es opt-in por spec y nunca default de `full`.
- **apply_patch y la variabilidad de diffs de los modelos**: unified estricto sin fuzz de contenido; error con archivo+hunk exactos; la descripción redirige a edit_file/multi_edit como ruta preferida.
- **remove_path/move_path destructivos**: `requiresApproval` + denyPaths generalizado + `workspaceGate` + `recursive` explícito + lstat anti-symlink + rehusar el root.
- **SPEC-01 y SPEC-05 tocan `LoopSpecSchema` a la vez**: ambos agregan SOLO campos `.optional()` al objeto `.strict()`; se acuerda que el content-hash CAMBIA al aparecer el campo (versiones distintas esperadas y documentadas, no bug).
- **Romper callers de `schemas()`**: la firma nueva es opcional; test snapshot de igualdad sin view.
- **`rg` ausente en la máquina de medición** (confirmado hoy): fallback JS con salida idéntica; `AITL_NO_RG=1` lo fuerza en CI/tests.
- **Registry global compartido en chat multi-turno** (`defaultRegistry`): el `ToolsetView` vive por sesión/run, no en el registry — activaciones no se fugan entre sesiones.

### Dependencias
- **SPEC-01 (loops)**: comparte la extensión de `LoopSpecSchema` (campo `toolset`); F3 se coordina con la fase de SPEC-01 que congele el schema (campos opcionales aditivos, sin conflicto real).
- **SPEC-02 (tiering)**: el router de tiers fija toolset por tier (p.ej. tier synthesize ⇒ `readonly`); consume `resolveToolset` tal cual.
- **SPEC-06 (multiagent)**: usa `Workspace` + `RunAgentOpts.workspaceRoot` + `workspaceGate` para confinar cada subagente a su worktree — esta spec entrega la pieza, SPEC-06 la cablea.
- **SPEC-09 (telemetry)**: consume `harness_config.toolset.schema_tokens` y los eventos `toolset_route`/`tool_activation` para el reporte de costo por modelo.
- **SPEC-11 (modelcat)**: llena el hook binding modelo→toolset de `resolveToolset` (aquí queda devolviendo null).
- **SPEC-12 (multimodal)**: registra `view_image`/`screenshot` como tools normales dentro de los toolsets (y en `defer` para modelos sin visión).
- **ADR-0070/AACL**: sin dependencia dura; `glob`/`grep` complementan el repomap (búsqueda ad-hoc vs símbolos indexados), no lo reemplazan — y el `workspaceGate` es el precursor natural de los leases por archivo de AACL (referidos, no re-especificados).
