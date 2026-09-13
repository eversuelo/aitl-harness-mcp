## SPEC-06 — Subagentes con `--worktree` + coordinación (absorbe AACL por referencia)
**Requisitos que cubre:** 8 (principal: multiagentes con `--worktree`, el harness lanza subagentes); toca 2 (loops de subagente), 6 (tier `implement` en subagentes, con SPEC-02), 11 (release coordinado al cierre, con SPEC-03) y 12 (presupuesto/costo por subagente, con SPEC-09)

### Objetivo y motivación
Hoy el harness YA lanza subagentes (`orchestrate()` fan-out en paralelo), pero el aislamiento es solo lógico: registry y contexto frescos por subagente, **mismo working tree**. Dos subagentes que editan `src/` pisan los archivos del otro y del humano; un `verify_cmd` de uno ve las ediciones a medias de su hermano; el stall detector (`workspaceDigest`) ve ruido ajeno; y no hay presupuesto ni coordinación por subagente. Esta spec añade aislamiento **físico** con `git worktree` por subagente (rama efímera + directorio propio), cablea el `cwd` que las tools no tienen (workspace binding), define política de merge/cleanup/límites, integra los claims de `src/coord/` (subtarea = claim; merge = lock) y enriquece los eventos `spawn` para el forense de SPEC-09. Los leases por archivo, `detect_conflicts` y el DAG NO se re-especifican: son AACL (ADR-0072 R2/R3/R4), absorbido por referencia.

### Estado actual (anclas de código verificadas)
- `src/orchestration/orchestrator.ts` — `orchestrate(master, project, opts)` (línea 66): `planSubtasks` (línea 50, una línea por subtarea, sin estructura), eventos `spawn` con payload `{index, task}` (líneas 87-93), fan-out `Promise.allSettled` (línea 94), `registry: new ToolRegistry()` por subagente (línea 103, aislamiento de gates ADR-0045), `summarize: false` (línea 99), síntesis final con `provider.complete` (línea 130). **Cero worktrees** (`grep -ri worktree src/ docs/` = 0).
- `src/orchestration/graph.ts` — `RunAgentOpts` (línea 36) con `budgets` (línea 99), `denyPaths` (51), `installDefaultTools` (56); las tools default se instancian en las líneas 241-244 (`new ReadFileTool(), new EditFileTool(), new WriteFileTool(), new ShellTool()`). Ese bloque es EL seam para inyectar cwd por subagente.
- `src/tools/filesystem.ts` — `ReadFileTool`/`WriteFileTool`/`EditFileTool` hacen `fs.readFile(String(args.path))` etc.: rutas relativas se resuelven contra `process.cwd()` del proceso único. `src/tools/shell.ts` — `ShellTool.run` llama `execAsync(command, { timeout, maxBuffer })` (líneas 36-45) **sin `cwd`**. Con N subagentes in-process, todos comparten cwd: este es el bug estructural a cerrar.
- `src/tools/base.ts` — `ToolRegistry.call()` con gates → pre-hooks → run → post-hooks (línea 118); un pre-hook que lanza ABORTA la call. `src/hooks/gates.ts` — `denyPathsGate(patterns)` (línea 20), `installDefaultGates` (líneas 57-60).
- `src/coord/claims.ts` — `claimTask(opts: ClaimOpts, deps)` (línea 175; `ClaimOpts = {project, taskKey, scope?, ownerId, ttlMs?}`; lock por índice único parcial + TTL `AITL_CLAIM_TTL_MS`, default 30 min), `heartbeat` (línea 244), `releaseTask` con `outcome: done|abandoned` (líneas 274-304), `coordOwnerId` (línea 42). `task_claims` tiene `task_key` y `scope` (`src/models/taskClaim.model.ts:28-29`) pero NO `resources[]` (eso es AACL R2).
- `src/models/event.model.ts` — `EVENT_TYPES` ya incluye `"spawn"` (línea 46); `payload` es `Schema.Types.Mixed` (línea 66) ⇒ enriquecer el payload no exige migración. `src/models/run.model.ts` — `harness_config: Mixed` (línea 42) para estampar metadatos de worktree.
- `src/util/git.ts` — helpers best-effort con `cwd` inyectable: `currentBranch`, `headSha`, `aheadCount(base, branch, cwd)` (línea 43), `changedFiles(cwd)`. `src/branches/sync.ts` — `syncBranches` (línea 22); `BRANCH_KINDS` (`src/models/branch.model.ts:19`). git 2.53.0 disponible.
- `src/cli.ts` — comando `orchestrate` (líneas 686-705): solo `--project/--model/--max`, `subAgentOpts: { installDefaultTools: true }`; `aitl coord` (línea 1726).
- `src/mcpserver/server.ts` — `TOOL_RBAC` (líneas 241-277; `run_agent: {resource:"memory", action:"create"}` en 276); patrón `run_agent` (línea 1224: zod + `budget_ms` default 600 000 + `runLogged`); `publish_event` (1411), `coord_status` (1433). `src/config/store.ts` — `ENV_KEYS` (línea 42), `configDir()` = `AITL_HOME ?? ~/.aitl` (líneas 101-103).
- ADR-0072 (`docs/adr/0072-aacl-canal-push-sse.md`, proposed) — R2 leases por recurso, R3 `detect_conflicts`, R4 DAG: dependencia por referencia.

### Diseño

#### Módulo nuevo: `src/worktree/manager.ts` (+ `manager.test.ts`)
Funciones sobre `git` con exec inyectable (mismo estilo que `ClaimStore`/`CoordDeps`), timeout 30 s por comando git; a diferencia de `util/git.ts`, aquí los errores LANZAN (crear un worktree a medias debe fallar ruidosamente):

```ts
export interface GitDeps { exec?: (args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }> }
export interface WorktreeSpec { repoRoot: string; branch: string; dir: string; baseRef?: string /* default "HEAD" */ }
export interface WorktreeHandle { repoRoot: string; dir: string; branch: string; baseSha: string }
export type MergePolicy = "branch-only" | "merge" | "patch" | "discard";
export interface IntegrateResult {
  policy: MergePolicy; committed: boolean; commitSha?: string;
  merged?: "merged" | "conflict" | "skipped"; conflictFiles?: string[]; patchPath?: string; branchKept: boolean;
}

export async function createWorktree(spec: WorktreeSpec, deps?: GitDeps): Promise<WorktreeHandle>; // git worktree add -b <branch> <dir> <baseRef>
export async function setupWorktree(h: WorktreeHandle, cmd: string, opts?: { timeoutMs?: number }, deps?: GitDeps): Promise<void>; // p.ej. "npm ci"
export async function commitAll(h: WorktreeHandle, message: string, deps?: GitDeps): Promise<string | null>; // add -A + commit; null si limpio
export async function integrateWorktree(h: WorktreeHandle, opts: { policy: MergePolicy; message: string }, deps?: GitDeps): Promise<IntegrateResult>;
export async function removeWorktree(h: WorktreeHandle, opts?: { deleteBranch?: boolean; force?: boolean }, deps?: GitDeps): Promise<void>; // worktree remove [+ branch -D]
export async function listWorktrees(repoRoot: string, deps?: GitDeps): Promise<{ dir: string; branch: string; head: string; prunable: boolean }[]>; // --porcelain, filtra aitl/sub/*
export function subagentBranchName(runId: string, index: number, task: string): string; // "aitl/sub/<runId8>/<i>-<slug≤24>"
export function defaultWorktreeDir(repoRoot: string): string; // ~/.aitl/worktrees/<basename>-<sha256(repoRoot)[:8]>/<branch-leaf>
```

Decisiones: los worktrees viven **fuera** del repo (bajo `configDir()/worktrees/`, coherente con `~/.aitl/profiles/` de ADR-0061) — cero ruido en `git status` del árbol principal, sin tocar `.gitignore` y sin contaminar repomap ni `capture-session` (que ya etiqueta mal rutas fuera de cwd). Namespace de ramas `aitl/sub/*`: `listWorktrees` y el GC jamás tocan ramas humanas. Commits de subagente llevan trailer `Aitl-Run: <run_id>` (el forense de SPEC-09 los liga al run sin heurísticas). Semántica de `integrateWorktree`:
- `branch-only` (**default**): `commitAll` y la rama queda viva; el humano u orquestador decide el merge después (SPEC-07 le calculará `merge_status`). Nunca auto-mergea = nunca rompe main.
- `merge`: tras commit, `git merge --no-ff <branch>` ejecutado en `repoRoot`, SERIALIZADO (merge-lock abajo) y PRE-CONDICIONADO a main tree limpio (`changedFiles(repoRoot).length === 0` — gotcha real del proyecto: trabajo sin commitear); conflicto ⇒ `git merge --abort`, resultado `"conflict"` + `conflictFiles`, rama viva.
- `patch`: `git format-patch <baseSha>..<branch> -o ~/.aitl/worktrees/patches/<runId8>/`; rama y worktree se limpian.
- `discard`: descarta todo (exploraciones/spikes, afín al council).
Guard anti-anidamiento: `createWorktree` falla si `git rev-parse --git-common-dir` en `repoRoot` no es su `.git` propio (repoRoot ya es worktree hijo), y `orchestrate()` con worktrees se rehúsa a re-orquestar dentro de uno (`AITL_IN_WORKTREE=1` en el entorno lógico del subagente).

#### cwd para las tools (workspace binding, seam aditivo)
`src/tools/filesystem.ts` y `src/tools/shell.ts` ganan constructor opcional — cero breaking (hoy se instancian sin args en graph.ts:241-244):

```ts
export interface WorkspaceOpts { root?: string }
// ReadFileTool/WriteFileTool/EditFileTool: constructor(private ws: WorkspaceOpts = {})
//   resolvePath(p) = isAbsolute(p) ? p : resolve(this.ws.root ?? process.cwd(), p)
// ShellTool: constructor(private ws: WorkspaceOpts = {})
//   execAsync(command, { timeout, maxBuffer, cwd: this.ws.root })
```

Gate nuevo en `src/hooks/gates.ts`:

```ts
export function worktreeScopeGate(root: string): SyncPermissionGate
// write_file/edit_file (y mkdir/mv/rm de SPEC-05): resuelve args.path contra root y deniega si
// relative(root, resolved).startsWith("..") — el subagente NO escribe fuera de su worktree.
// El mensaje de denegación es pedagógico («path X fuera del workspace <root>; usa rutas relativas»):
// el modelo aprende del feedback, mismo patrón que los errores de edit_file.
// shell: modo estricto opt-in (AITL_WORKTREE_STRICT_SHELL=1) deniega comandos con rutas absolutas
// fuera de root o `cd ..`; sin él, mitigan cwd + denyPathsGate (riesgo residual documentado).
```

`RunAgentOpts` (graph.ts:36) gana `workspaceRoot?: string`: en el bloque 241-244, si viene, las tools default se construyen con `{ root }`, se añade `worktreeScopeGate(root)` y se estampa `harness_config.workspace = { root, branch, base_sha }` en el run doc (Mixed, sin migración). `aitl run` gana `--workspace-root <dir>` (útil también sin orquestación: correr el loop contra otro repo). Las tools MCP montadas (`mcp__*`) no conocen cwd — limitación documentada en `docs/MULTIAGENT.md`.

#### Orquestador: fan-out con worktrees, claims, concurrencia y presupuesto
`OrchestrateOpts` (orchestrator.ts:21) gana campos aditivos:

```ts
worktree?: {
  repoRoot?: string;          // default: `git rev-parse --show-toplevel` del cwd
  baseRef?: string;           // default "HEAD"
  mergePolicy?: MergePolicy;  // default "branch-only" | env AITL_WORKTREE_MERGE_POLICY
  setup?: string;             // comando post-create en el worktree (p.ej. "npm ci"); sin él, deps ausentes
  keepOnError?: boolean;      // default true: el worktree de un subagente fallido queda para forense
  maxWorktrees?: number;      // default min(maxSubagents, AITL_WORKTREE_MAX=8)
};
concurrency?: number;         // ventana de paralelismo (default maxSubagents); semáforo inline, sin dep nueva
subBudgets?: { tokens?: number; ms?: number };   // → RunAgentOpts.budgets de CADA subagente (ADR-0062)
budgetTotal?: { tokens?: number; ms?: number };  // alternativa: se divide equitativamente entre las subtareas
claims?: boolean;             // default true con worktree: claim por subtarea vía src/coord
```

Flujo por subtarea `i` (reemplaza el cuerpo del map de la línea 94, mismo `Promise.allSettled`, envuelto en try/finally):
1. `claimTask({ project, taskKey: `subtask:${runId}:${i}`, scope: branch, ownerId: `sub:${runId}:${i}`, ttlMs: subBudgets.ms ?? claimTtlMs() })` — conflicto (`ok:false`) ⇒ subtarea marcada `skipped_conflict` SIN correrla (otro actor/harness la tiene: coordinación multi-harness real, no error). `heartbeat` cada `ttl/3` mientras el subagente corre.
2. `createWorktree({ repoRoot, branch: subagentBranchName(runId, i, task), dir: defaultWorktreeDir(...), baseRef })` + `setupWorktree` si hay `setup` (timeout duro).
3. Evento `spawn` **enriquecido**: `payload: { index, task, worktree: { dir, branch, base_sha }, budgets, model, claim_key }` (Mixed: aditivo). Además `recordCoordNote(project, "note", ...)` best-effort (`src/coord/events.ts`) para que OTROS harneses vean el spawn en su `coord poll`.
4. `runAgent(task, project, { workspaceRoot: dir, budgets, registry: new ToolRegistry(), installDefaultTools: true, summarize: false, ...subAgentOpts })`.
5. Al settle: `commitAll(h, `aitl-sub(${i}): ${slug}\n\nAitl-Run: ${sub.run_id}`)` (red de seguridad: el trabajo queda SIEMPRE en su rama aunque el modelo no commiteara) → integración SERIALIZADA: el orquestador toma el lock `claimTask({ taskKey: `merge-lock:${sha8(repoRoot)}` })` (el índice único parcial ES el mutex, sobrevive a N orquestadores concurrentes), llama `integrateWorktree`, libera. Nunca merges en paralelo: comparten `.git`.
6. `releaseTask({ outcome: status === "done" ? "done" : "abandoned" })` → `removeWorktree` según policy/`keepOnError`.
7. Eventos nuevos en `EVENT_TYPES` (extensión de enum, aditiva): `"worktree_create"`, `"worktree_integrate"` (payload `{ branch, merged, commit_sha, conflictFiles? }`), `"worktree_cleanup"`.
8. La síntesis final del orquestador (línea 122-130) añade por subagente: rama, commit, resultado de merge — y best-effort `syncBranches` (`src/branches/sync.ts:22`) para que las ramas `aitl/sub/*` entren al catálogo `branches` (kind `other`; SPEC-07 les computa `merge_status`).

`SubAgentOutcome` gana `worktree?: { branch: string; dir: string; merged?: IntegrateResult["merged"]; commit_sha?: string }` y `claim?: { key: string; outcome: "done" | "abandoned" | "skipped_conflict" }`. `OrchestrateResult` gana `integration?: { merged: number; conflicts: string[]; kept: string[] }`.

#### CLI
```
aitl orchestrate "<task>" --project aitl-js --worktree \
  [--merge-policy branch-only|merge|patch|discard] [--base <ref>] [--setup "npm ci"] [--keep-worktrees] \
  [--concurrency 2] [--sub-budget-ms 600000] [--sub-budget-tokens 200000] [--tasks-file subtareas.txt] [--max 4] [--json]

aitl worktree list  [--repo <dir>] [--json]      # listWorktrees + claims activos sub:* del project + ahead/behind
aitl worktree merge <branch> [--repo <dir>]      # integrateWorktree policy "merge" bajo merge-lock; aterrizaje manual del branch-only
aitl worktree gc    [--repo <dir>] [--force]     # git worktree prune + borra huérfanos bajo ~/.aitl/worktrees; NUNCA borra
                                                 # ramas con commits no aterrizados (aheadCount > 0, util/git.ts:43) salvo --force
```

#### Tool MCP nueva: `orchestrate_task`
Patrón `run_agent` (server.ts:1224): `server.tool` + `runLogged` + entrada RBAC + canario en `mcpserver/rbac.test.ts`.

```ts
server.tool("orchestrate_task", "Fan-out a subagentes paralelos (opcionalmente aislados en git worktrees) y síntesis final.", {
  project: z.string(),
  task: z.string(),
  tasks: z.array(z.string()).optional().describe("Subtareas explícitas; si faltan, el modelo descompone."),
  max_subagents: z.number().int().min(1).max(8).default(4),
  worktree: z.boolean().default(false),
  repo_root: z.string().optional(),
  merge_policy: z.enum(["branch-only", "merge", "patch", "discard"]).default("branch-only"),
  setup_cmd: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  sub_budget_ms: z.number().int().positive().default(600_000),   // mismo default anti-cuelgue que run_agent
  sub_budget_tokens: z.number().int().positive().optional(),
}, handler)
// TOOL_RBAC (server.ts:241): orchestrate_task: { resource: "memory", action: "create" }  // mismo catch-all que run_agent (:276)
// Respuesta: { run_id, subagents: [{run_id, task, status, worktree?, claim?}], integration, final_text (clip 4000) }
```

#### Config/env
Añadir a `ENV_KEYS` (store.ts:42, visibles en perfiles ADR-0061 y en la pestaña web Config): `AITL_WORKTREE_DIR` (override del default `~/.aitl/worktrees`), `AITL_WORKTREE_MAX` (default 8), `AITL_WORKTREE_MERGE_POLICY`, `AITL_WORKTREE_STRICT_SHELL`. Ejemplo `.env`:
```
AITL_WORKTREE_MAX=4
AITL_WORKTREE_MERGE_POLICY=branch-only
```

#### AACL y tiering, por referencia
- **ADR-0072 R2/R3/R4 (dependencia, no re-spec)**: cuando aterricen los leases por recurso, `planSubtasks` se extiende a salida estructurada `{ task, files: string[] }[]` (vía `CompleteOpts.jsonSchema`, ADR-0044, con fallback al parser por líneas actual) y el orquestador pide un lease por glob ANTES de crear cada worktree; `detect_conflicts` corre como pre-flight del merge. HASTA entonces: los `files` planificados van a `claim.scope` (campo existente, taskClaim.model.ts:29) y al payload del spawn — la coordinación vigente es claims por `task_key` + instrucción de independencia en `planSubtasks`, y los solapes se detectan post-hoc como conflicto git (degradación aceptable y medible). El DAG (R4) queda fuera: `concurrency` NO modela dependencias.
- **SPEC-02**: el orquestador planifica y sintetiza con tier `design`; cada subagente corre con tier `implement` (`subAgentOpts.provider`); esta spec solo consume el binding.

### Fases de implementación
- **F1 — Worktree manager**: `src/worktree/manager.ts` + `manager.test.ts` (GitDeps fake para unit; E2E real sobre repo `mktemp` + `git init` + commit semilla: create → setup → write → commitAll → integrate en las 4 policies → remove → list). Verifica: `npm run verify` verde; el E2E comprueba `git worktree list` limpio al final, rama viva en `branch-only`, abort+`conflictFiles` en conflicto y guard anti-anidamiento.
- **F2 — Workspace binding**: `WorkspaceOpts` en filesystem/shell, `worktreeScopeGate` en gates.ts, `RunAgentOpts.workspaceRoot` cableado en graph.ts:241-244 + stamp `harness_config.workspace` + `aitl run --workspace-root`. Verifica: tests de gate (ruta `../fuera` denegada, absoluta fuera denegada, relativa dentro permitida); E2E: `runAgent` con provider fake escribe `hola.txt` BAJO el root temporal, no bajo `process.cwd()`, y `aitl run-show` muestra el stamp.
- **F3 — Orquestador + CLI**: `worktree/concurrency/subBudgets/budgetTotal/claims` en `OrchestrateOpts`, flujo 1-8, merge-lock, `SubAgentOutcome.worktree/claim`, eventos nuevos, flags de `aitl orchestrate` y `aitl worktree list|merge|gc`. Verifica: E2E vivo `aitl orchestrate --worktree --max 2 --merge-policy branch-only` sobre repo de juguete (provider fake o Chutes): 2 ramas `aitl/sub/*` con commits trailer `Aitl-Run:`, claims released `done` en Mongo (`aitl coord list`), `aitl worktree gc` deja `git worktree list` limpio pero respeta la rama unmerged; tests unit del reparto de `budgetTotal`, del semáforo y del `skipped_conflict`.
- **F4 — MCP + docs**: `orchestrate_task` + RBAC + canario + `ENV_KEYS` + `docs/MULTIAGENT.md` (guía: cuándo worktrees, políticas, setup de deps, límites, limitación de tools MCP sin cwd). Verifica: `mcpserver/rbac.test.ts` verde; llamada MCP viva devuelve `{ run_id, subagents[] }` (recordar reinicio del server MCP: gotcha conocido de build viejo).
- **F5 (diferible) — Plan estructurado**: `planSubtasks` → `{ task, files[] }` con jsonSchema; enganche a leases/`detect_conflicts` cuando AACL R2/R3 existan. Verifica: test de parseo estructurado con fallback al formato una-línea actual.

### ADRs a registrar
- «Aislamiento físico de subagentes con git worktree: manager, workspace binding de tools y gate de alcance» — proposed → accepted al cerrar F2.
- «Fan-out coordinado del orquestador: claim por subtarea, merge-lock serializado, presupuesto por subagente y política de integración branch-only por defecto» — proposed → accepted al cerrar F4; referencia ADR-0072 (AACL) como evolución de la coordinación y ADR-0045 (registry por subagente) como precedente de aislamiento.
- «Tool MCP orchestrate_task: el fan-out multiagente como superficie MCP» — accepted en F4 (puede fundirse con el anterior si la sesión lo cierra junto).

### Medición para la tesis
La tesis declara «sistema multiagente complejo» FUERA de alcance (cap. 1) y no menciona worktrees ⇒ entra como **capacidad del artefacto sin compromiso evaluativo** (precedente: roles H11 degradado), con dos salvaguardas que SPEC-10 debe ejecutar: (a) actualizar la delimitación de alcance del cap. 1 («multiagente acotado: fan-out aislado por worktrees, sin negociación entre agentes») y la sección de coordinación v2; (b) si se decide medir, celda exploratoria `c2-multiagent` (n=1, no confirmatoria) sobre fases paralelizables del raytracer (p.ej. materiales y luces) vs la misma carga secuencial, con métricas ya capturadas por esta spec: wall-clock total vs secuencial, tokens/`costo_pond` por subagente (eventos `spawn` enriquecidos + trailer `Aitl-Run:` + SPEC-09), % de merges limpios (`worktree_integrate.merged`), conflictos git y claims `skipped_conflict` (coordinación efectiva). Las métricas «conflictos evitados / espera por lease» del ADR-0072 quedan reservadas a cuando AACL aterrice. Fila IMPL en la bitácora en cualquier caso.

### Riesgos y mitigaciones
- **Merges automáticos rompen main** → default `branch-only` (nunca auto-merge); `merge` es opt-in, serializado bajo merge-lock, pre-condicionado a main tree limpio y con abort en conflicto (rama sobrevive).
- **`.git` compartido entre worktrees** (refs/index.lock concurrentes) → cada worktree tiene índice propio (commits paralelos seguros); todo lo que toca refs compartidas (merge, branch -D, prune) va SECUENCIAL bajo el merge-lock.
- **Deps no instaladas en el worktree** (node_modules ausente → `verify_cmd` del subagente falla en falso) → `worktree.setup` (p.ej. `npm ci`) con timeout duro; documentar el costo y la alternativa (verify que no exija deps).
- **Shell escapa del worktree** (cwd no es sandbox) → `worktreeScopeGate` para tools de archivos + `AITL_WORKTREE_STRICT_SHELL` + denyPaths existentes; riesgo residual documentado en docs/MULTIAGENT.md — aislamiento operativo, no sandbox hostil (consistente con `--ask`).
- **Fugas de disco / worktrees huérfanos** (crash a mitad de fan-out) → try/finally libera claims; los worktrees quedan a propósito (contienen trabajo); `aitl worktree gc` + `git worktree prune` con guard `aheadCount` anti-pérdida; tope `AITL_WORKTREE_MAX`; todo bajo un único dir raíz conocido.
- **Dos subagentes tocan el mismo archivo** (claims son por task_key, no por archivo) → instrucción de independencia en `planSubtasks` hoy; solución real = leases AACL R2/R3 (por referencia, F5); mientras, el conflicto aflora en el merge, nunca silenciosamente.
- **Costo ×N de tokens** → `subBudgets`/`budgetTotal` con default 600 000 ms como `run_agent`; el evento spawn lleva el presupuesto para auditoría (SPEC-09).
- **Tools MCP montadas ignoran el cwd** → limitación documentada; los subagentes con worktree reciben por default SOLO las tools nativas (registry fresco); montar MCP es decisión explícita del llamador.

### Dependencias
- **ADR-0072 AACL (proposed, por referencia)**: R2 leases por recurso y R3 `detect_conflicts` sustituyen la coordinación por task_key en F5; R4 DAG fuera de esta spec. Esta spec funciona COMPLETA sin AACL.
- **SPEC-02 `tiering`**: provider `design` para planear/sintetizar, `implement` para subagentes (esta spec solo consume el binding).
- **SPEC-05 `filetools`**: las tools nuevas (mkdir/mv/rm/glob/grep) DEBEN aceptar `WorkspaceOpts` y entrar al `worktreeScopeGate`; los toolsets por perfil aplican al registry fresco de cada subagente (donde se monta el toolset reducido para modelos chicos).
- **SPEC-03 `sintesis`**: los subagentes corren `summarize:false` (como hoy, orchestrator.ts:99); el gate «no done sin memoria» aplica al run del ORQUESTADOR, y el `releaseTask` por subtarea de esta spec es insumo de ese gate.
- **SPEC-07 `ledger`**: consume las ramas `aitl/sub/*` sincronizadas (`syncBranches`) para calcular `merge_status` de lo no aterrizado.
- **SPEC-09 `telemetry`**: consume eventos `spawn`/`worktree_*` y el trailer `Aitl-Run:` para costo por subagente y timeline de sesión.
- **SPEC-01 `loops`**: `loopSpec` por subtarea viaja intacto vía `subAgentOpts` (ya soportado por `RunAgentOpts.loopSpec`).
- **SPEC-10 `thesis`**: actualización de alcance cap. 1 y celda `c2-multiagent`.
