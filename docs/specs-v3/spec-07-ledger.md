## SPEC-07 — Ledger de decisiones con estado de merge a main
**Requisitos que cubre:** 10 (principal); apoya 7 (hydrate avisa qué decisiones aún no rigen en main) y 12 (insumo del forense de sesión de SPEC-09: qué decisión aterrizó dónde).

### Objetivo y motivación

El pedido literal: «saber qué ADRs/decisiones se tomaron, en qué repos, y si ya se hizo merge a main». Hoy el ledger responde el *qué* (ADRs 0001–0075 contiguos, versionados append-only) y a medias el *dónde* (cada versión estampa `branch` + `commit_sha`, pero **no el repo** — en proyectos multi-repo una rama `feat/x` es ambigua). El *estado* no lo responde nadie: `grep -rn "merge_status|is-ancestor|--merged" src/ web/src/` = **0 hits** (verificado 2026-07-17). El síntoma vive en el propio harness: los ADRs 0046–0075 se autoraron en `feat/harness-v2` y ni hydrate, ni la web, ni el CLI saben cuáles rigen ya sobre `main` — el agente siguiente asume como ley decisiones cuyo código quizá nunca se mergeó. Esta spec convierte la memoria de decisiones en un **ledger contable**: cada asiento (ADR) conoce su repo, rama, commit y estado de liquidación contra el trunk (`merged`/`merged_squash`/`unmerged`), calculado con git local (`merge-base --is-ancestor`, `git cherry`), cacheado en Mongo **sin tocar el versionado de contenido**, y visible en las cuatro superficies: MCP, CLI, web e hydrate.

### Estado actual (anclas de código verificadas)

- **Catálogo de ramas sin merge**: `src/models/branch.model.ts:24-42` — `kind/environment/base/protectedBranch/head_sha/remote`, ningún campo de merge (brecha exacta del requisito 10). `syncBranches()` (`src/branches/sync.ts:22-53`, trunks en `TRUNK_NAMES` :12) clasifica y upserta vía `BranchStore.upsert` (`src/branches/store.ts:12-27`, que ya pre-lee el doc existente — punto natural para detectar transiciones).
- **Decisiones con procedencia parcial**: `src/models/decision.model.ts:54-55` — `branch` (ADR-0028) y `commit_sha` (0049), **sin `repo`**. `ADRStore.upsert` (`src/decisions/adr.ts:90-113`) defaultea `currentBranch()`/`headSha()` con el **cwd del proceso**: la tool `record_decision` (`src/mcpserver/server.ts:758-789`, estampa `branch: currentBranch()` en :782) hereda el cwd del *server MCP*, no el del repo de la decisión — caveat que esta spec corrige.
- **Git helpers sin ancestry**: `src/util/git.ts` — `git()` privado nunca-lanza (:8-14) colapsa exit≠0 en `null`, `aheadCount()` (:44-49), `repoRoot()` (:94-96). `merge-base --is-ancestor` comunica por exit code (0=sí, 1=no), así que necesita wrapper tri-estado propio.
- **Trunk detection ya existe**: `detectBaseTrunk()` con prioridad main>master>develop>dev (`src/branches/reindex.ts:19-29`), usada por `aitl branch sync --reindex` (`src/cli.ts:1619-1657`).
- **Refresh gratis post-merge**: `aitl init` instala el hook git `post-merge` que corre `aitl branch sync --reindex` (`src/init/initRepo.ts:401-418`) — al computar merge dentro de `syncBranches`, cada merge local refresca el ledger sin hooks nuevos.
- **Versionado a proteger**: `ADR_CONTENT_FIELDS = ["title","context","decision","consequences","status"]` (`src/memory/versioning.ts:27`) — los campos de merge quedan FUERA para no provocar bumps de versión ni entradas en `decisions_history`.
- **Superficies**: tools `sync_branches` (server.ts:1122-1133, RBAC `branches:create` en `TOOL_RBAC` :267) y `list_decisions` (:745-756); canario RBAC `MUTATING_TOOLS` + `assert.deepEqual` (`src/mcpserver/rbac.test.ts:11,64`); CLI `aitl adr {history,deprecate}` (cli.ts:1444-1496) y `aitl branch {sync,list}` (:1619-1675); web `DecisionsView`/`DecisionStatusBadge` (`web/src/App.tsx:554,521`) sobre `GET /api/decisions` (`src/server/api.ts:755-764`, proyección solo excluye `embedding` — campos nuevos fluyen gratis).
- **Hydrate ya tiene el patrón de aviso**: `hydrate()` (`src/memory/lifecycle.ts:236-326`) emite una línea-puntero para ADRs con `review_after` vencido (:303-306) y los devuelve estructurados en `HydrateResult.needs_review` (:203-214) — patrón exacto a replicar.
- **Bus de coordinación**: `COORD_EVENT_TYPES` (`src/models/coordEvent.model.ts:19-27`) y `recordCoordNote(project, type, payload, opts)` best-effort (`src/coord/events.ts:78-83`), hoy restringido a `"decision"|"task_done"|"note"` por `CoordNoteType` (:71).
- **Multi-repo**: `RepoStore.list({project})` (`src/repos/store.ts:29`) y campo `path` (raíz local, `src/models/repo.model.ts:27`) — materia prima para verificar con git vivo repo por repo.

### Diseño

#### 1. Semántica de `merge_status` y helpers git (`src/util/git.ts`, aditivo)

```ts
export const MERGE_STATUSES = ["trunk", "merged", "merged_squash", "unmerged", "unknown"] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];
```

`trunk` = la rama ES el trunk (o la decisión nació en él); `merged` = ancestro real del trunk (merge/fast-forward); `merged_squash` = patch-id equivalente en el trunk (heurística honesta para squash/rebase); `unmerged` = vivo con `ahead` commits por delante; `unknown` = sin datos (sha inalcanzable, repo sin `path`, sin caché) — **nunca se inventa**. Helpers nuevos, mismo contrato never-throw:

```ts
/** ¿ancestor ⊆ descendant? true/false por exit code de `git merge-base --is-ancestor`; null en error real. */
export function isAncestor(ancestor: string, descendant: string, cwd = process.cwd()): boolean | null;
// impl: execFileSync propio (NO el git() genérico): catch err.status === 1 → false; resto → null
/** Ramas locales ya contenidas en trunk (`git branch --merged <trunk> --format=%(refname:short)`), [] en error. */
export function mergedBranches(trunk: string, cwd = process.cwd()): string[];
/** ¿El commit existe en este repo? (`git cat-file -e <sha>^{commit}`) — sonda multi-repo. */
export function commitInRepo(sha: string, cwd = process.cwd()): boolean;
/** ¿El patch de <ref> ya está en <trunk>? (`git cherry <trunk> <ref> <ref>~1` → línea "-"). null si ~1 no resuelve. */
export function cherryEquivalent(trunk: string, ref: string, cwd = process.cwd()): boolean | null;
```

Resolución del trunk (precedencia): flag `--trunk` > `repo.metadata.trunk` (campo `metadata` Mixed ya existente en repo.model.ts) > env nueva `AITL_LEDGER_TRUNK` (entra a las ENV_KEYS de ADR-0061 y a la pestaña Config) > `detectBaseTrunk()` (reindex.ts:22).

#### 2. Rama-nivel: caché en el catálogo (`src/branches/mergeStatus.ts` + `branch.model.ts`)

```ts
export interface BranchMergeInfo { merge_status: MergeStatus; merged_into: string | null; ahead_of_trunk: number | null; }
/** UN `git branch --merged` para el lote + un aheadCount por rama viva + cherryEquivalent para las dudosas. */
export function computeBranchMerge(names: string[], trunk: string | null, root: string): Map<string, BranchMergeInfo>;
```

Campos aditivos en `branch.model.ts` (defaults compatibles con docs viejos, sin migración):

```ts
merge_status:     { type: String, enum: MERGE_STATUSES, default: "unknown" },
merged_into:      { type: String, default: null },  // trunk donde aterrizó ("main")
ahead_of_trunk:   { type: Number, default: null },  // rev-list --count trunk..rama
merge_checked_sha:{ type: String, default: null },  // head del trunk al medir (invalidación de caché)
merge_checked_at: { type: Date,   default: null },
```

`syncBranches()` (sync.ts:31-51) llama `computeBranchMerge` una vez por lote y estampa los 5 campos en cada upsert; la tool `sync_branches` gana el flag aditivo `merge_status: z.boolean().default(true)` (schema en server.ts:1125). El hook `post-merge` existente refresca esto en cada merge sin cambios.

#### 3. Decisión-nivel: `src/decisions/ledger.ts` + procedencia `repo`

Campos aditivos en `decision.model.ts` — `repo` es procedencia (familia de `branch`/`commit_sha`); `merge_*` es **estado derivado y volátil**:

```ts
repo:             { type: String, default: null },  // sub-scope repo donde se autoró (ADR-0028)
merge_status:     { type: String, enum: ["merged", "merged_squash", "unmerged", "trunk", "unknown"], default: "unknown" },
merged_into:      { type: String, default: null },
merge_checked_at: { type: Date,   default: null },
```

```ts
export interface LedgerEntry {
  id: string; title: string; status: AdrStatus;
  repo: string | null; branch: string | null; commit_sha: string | null;
  merge_status: MergeStatus; merged_into: string | null; ahead_of_trunk: number | null;
  evidence: "commit" | "branch" | "none";   // qué señal decidió (commit gana a rama)
  checked_at: Date | null;
}
export interface LedgerReport {
  project: string; repos: { name: string; path: string | null; trunk: string | null; live: boolean }[];
  entries: LedgerEntry[];
  summary: Record<MergeStatus, number> & { coverage: number }; // coverage = % con estado ≠ unknown
}
export async function decisionLedger(project: string,
  opts?: { id?: string; repo?: string; only?: MergeStatus; refresh?: boolean; limit?: number }): Promise<LedgerReport>;
/** Persistencia de la caché: $set directo sobre `decisions` — NUNCA vía ADRStore.upsert. */
export async function refreshDecisionMergeStatus(project: string, opts?: { repo?: string }): Promise<{ checked: number; landed: string[] }>;
```

**Resolución multi-repo por decisión** (orden, con memoización por corrida): (1) `decision.repo` explícito; (2) proyecto con un único repo con `path` no vacío → ese; (3) sonda `commitInRepo(commit_sha, repo.path)` sobre `RepoStore.list({project})` — los SHAs son únicos entre repos sin historia compartida; (4) fallback rama-nivel: caché `(project, *, branch)` del catálogo `branches` (evidence `"branch"`); (5) nada → `unknown`/`"none"`.

**Cálculo commit-nivel** (evidence `"commit"`, el preciso): `isAncestor(commit_sha, trunk, path)` — sobrevive a ramas borradas tras el merge, cherry-picks y decisiones nacidas en el trunk; si falla ancestry, segunda pasada `cherryEquivalent` → `merged_squash`. Coste acotado: dedupe por `(repo, commit_sha)` y `(repo, branch)` únicos antes de llamar git — O(refs únicas), no O(decisiones); sin `refresh`, cero procesos git (solo caché).

**Regla dura de versionado**: `refreshDecisionMergeStatus` escribe `updateOne({project,id},{$set:{merge_*, repo?}})` directo — ni bump de `version`, ni `decisions_history`, ni re-embedding (`ADR_CONTENT_FIELDS`, versioning.ts:27, no se toca; test de F2 lo fija). Al detectar transición `unmerged→merged|merged_squash` emite el evento del §6.

#### 4. Procedencia correcta al escribir + backfill

- `record_decision` (server.ts:758) gana el param opcional `repo: z.string().optional()`: si viene, resuelve `RepoStore.get(project, repo).path` y estampa `branch: currentBranch(path)` + `commit_sha: headSha(path)` + `repo` — en vez del cwd del server MCP (:782 hoy). `ADRStore.upsert` ya acepta overrides (adr.ts:90-93); solo suma `repo` al doc.
- Helper nuevo `resolveRepoForCwd(project, cwd)` (`src/repos/resolve.ts`): matchea `repoRoot(cwd)` (git.ts:94) contra los `path` del catálogo, fallback `basename`; lo usan el CLI y `aitl sync` (con el project de `.aitl/project.json`, ADR-0063).
- `aitl adr backfill --project X [--apply]`: para decisiones con `repo == null`, sonda `commitInRepo` en cada repo del catálogo; match único → estampa `repo` (vía `$set`, sin bump); ambiguo/sin match → reporte y `null`. Regla extra: `branch == trunk` ⇒ `merge_status: "trunk"` inmediato (cubre los ADRs históricos 0001–0045 autorados en `main`).

#### 5. Tool MCP nueva `decision_status` (+ extensión mínima de `sync_branches`)

```ts
server.tool("decision_status",
  "Ledger de decisiones: por cada ADR, repo/rama/commit donde se tomó y si ya aterrizó en el trunk (merge-base --is-ancestor; squash vía git cherry). `refresh` recalcula contra git local y cachea.",
  { project: z.string(), id: z.string().optional(), repo: z.string().optional(),
    only: z.enum(MERGE_STATUSES).optional(), refresh: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100) },
  async (a) => runLogged("decision_status", a, async () => {
    const { decisionLedger } = await import("../decisions/ledger.js");
    return text(jsonable(await decisionLedger(a.project, a)));
  }));
```

RBAC: `decision_status: { resource: "decisions", action: "update" }` en `TOOL_RBAC` (mutante por el `refresh` que persiste caché) + entrada en `MUTATING_TOOLS` del canario (rbac.test.ts:11; el `deepEqual` de :64 rompe en CI si se olvida). `list_decisions` **no se toca**: los campos cacheados salen gratis en sus docs. `sync_branches` gana `refresh_decisions: z.boolean().default(false)` que encadena `refreshDecisionMergeStatus` bajo su RBAC ya existente.

#### 6. Evento de coordinación `decision_landed`

`COORD_EVENT_TYPES` (coordEvent.model.ts:19-27) gana el miembro aditivo `"decision_landed"` y `CoordNoteType` (events.ts:71) lo incluye en su `Extract`. Lo emite `refreshDecisionMergeStatus` en cada transición a merged: `recordCoordNote(project, "decision_landed", { branch, merged_into, decisions: ["0074","0075"] })` — best-effort por contrato, jamás rompe el refresh. Como el hook `post-merge` dispara `branch sync --reindex` (initRepo.ts:401-418), los peers con `aitl coord poll` se enteran del aterrizaje sin acción manual; cuando AACL exista, el mismo evento viaja push (por referencia).

#### 7. CLI `aitl adr status` (subcomando del grupo existente, cli.ts:1444)

```
aitl adr status --project aitl-js [--repo <r>] [--id 0062] [--trunk main]
                [--only unmerged] [--refresh] [--fetch] [--json] [--fail-unmerged]
# ADR   estado     merge               repo             rama              commit   verificado
# 0075  proposed   ✗ sin main (+14)    AITL-Harness-JS  feat/harness-v2   3f2a1c9  hace 2 h
# 0062  accepted   ✔ main              AITL-Harness-JS  feat/harness-v2   91b02ae  hace 2 h
# 0051  accepted   ● trunk             AITL-Harness-JS  main              88aa021  hace 2 h
# 0007  accepted   ? sin datos git     —                —                 —        —
# Resumen: 61 merged · 2 squash · 9 sin aterrizar · 3 unknown · cobertura 96%
```

`--refresh` invoca `refreshDecisionMergeStatus` (sin él lee caché y muestra `merge_checked_at`); `--fetch` corre `git fetch --quiet` best-effort antes (el estado refleja refs LOCALES — documentado); `--fail-unmerged` sale con código 3 si hay `unmerged` (gate de CI o de cierre de sesión, componible con el gate de SPEC-03); `--json` vuelca el `LedgerReport`. `aitl branch list` (cli.ts:1659-1675) añade el sufijo `[merged→main]` / `[+N sin merge]` desde la caché.

#### 8. Hydrate avisa lo no-aterrizado (`src/memory/lifecycle.ts`)

Tras la sección de decisiones (patrón exacto de :303-306): consulta best-effort de la caché — `find({ project, merge_status: "unmerged", status: { $nin: INACTIVE_ADR_STATUSES } }, { projection: { id:1, branch:1, title:1 } }).limit(10)` — **cero git en el hot path** (el hook `UserPromptSubmit` debe seguir <1s) y UNA línea-puntero:

```
⚠ Decisiones aún NO aterrizadas en main: 0074, 0075 (feat/harness-v2). Verifica que el código que asumen exista en tu rama.
```

`HydrateResult` (:203-214) gana el campo aditivo `unlanded: { id: string; title: string; branch: string | null }[]`. Guarda anti-falso-positivo: si la caché nunca se pobló (todo `unknown`), no se emite nada.

#### 9. Web y espejo markdown

- `DecisionsView` (App.tsx:554): `MergeBadge` junto a `DecisionStatusBadge` (:521) — verde `✔ main`, verde punteado `✔ squash`, neutro `● trunk`, ámbar `✗ sin merge (+N)`, gris `?` — con tooltip repo/rama/commit/`merge_checked_at`; filtro «sin aterrizar». `DecisionDoc` (`web/src/api.ts:26`) suma los campos opcionales; API: param opcional `?merge_status=unmerged` en `GET /api/decisions` (api.ts:755). Sin git en el path HTTP: solo caché.
- **Decisión explícita**: el espejo `docs/adr/*.md` de `aitl sync` NO exporta `merge_*` — estado volátil que ensuciaría el manifiesto de dos hashes (ADR-0051) con conflictos espurios en cada refresh. El markdown es el acta; el estado vive en Mongo.

### Fases de implementación

- **F1 — Rama-nivel**: helpers git (`isAncestor`, `mergedBranches`, `commitInRepo`, `cherryEquivalent`) + `mergeStatus.ts` + campos en `branch.model.ts` + integración en `syncBranches` + flag en la tool. *Verifica*: tests con repo git efímero (`mkdtempSync` + `git init` + rama mergeada, rama squash-mergeada, rama viva — patrón de `util/git.test.ts:22-29`) en `src/branches/mergeStatus.test.ts`; `npm run verify` verde; E2E: `aitl branch sync --project aitl-js --repo AITL-Harness-JS --root .` y `aitl branch list` muestra `feat/harness-v2 [+N sin merge]` y `main [trunk]`.
- **F2 — Decisión-nivel**: `decisions/ledger.ts` + campos y `repo` en `decision.model.ts` + param `repo` en `record_decision`/`ADRStore.upsert` + `resolveRepoForCwd` + CLI `aitl adr {status,backfill}`. *Verifica*: `decisions/ledger.test.ts` (decisión con commit en trunk / en rama viva / sha inexistente / sin procedencia → merged/unmerged/unknown/unknown) + **test clave: refresh NO bumpea `version` ni escribe `decisions_history`** (aserción directa sobre ambas colecciones); E2E real: los ADRs 0046+ del propio harness salen `unmerged` contra `main` mientras `feat/harness-v2` no aterrice, y `backfill` estampa `repo`/`trunk` en los históricos.
- **F3 — Superficie MCP + avisos**: tool `decision_status` + RBAC + canario actualizado + `refresh_decisions` en `sync_branches` + enum `decision_landed` + aviso en `hydrate()`. *Verifica*: `node --test src/mcpserver/rbac.test.ts` (deepEqual con la tool nueva); test de lifecycle con caché sembrada (`unmerged` ⇒ línea ⚠ y `HydrateResult.unlanded`; caché virgen ⇒ silencio); E2E: `aitl hydrate --project aitl-js "x"` imprime el aviso; merge en repo temporal + `branch sync` ⇒ `aitl coord poll` entrega `decision_landed`. Reinicio del server MCP para exponer la tool.
- **F4 — Web + docs**: `MergeBadge`, filtro, campos en `DecisionDoc`, param del API + test del handler con caché sembrada; sección «Ledger de decisiones» en `docs/ARQUITECTURA.md`. *Verifica*: `npm run build:web` (cwd=web) + E2E visual en la pestaña Decisions.

### ADRs a registrar

- «Ledger de decisiones con estado de merge: `merge_status` derivado por git local (ancestry + patch-id para squash), cacheado por `$set` directo sin bump de versión, con aviso en hydrate y evento `decision_landed`» (proposed al diseñar, accepted al cerrar F3).
- «Procedencia `repo` en ADRs: campo nuevo + resolución multi-repo commit-first + backfill; documenta el fix del cwd del server MCP como deuda saldada» (accepted en F2).

### Medición para la tesis

- **Métrica principal (bitácora IMPL + cap. 4, sin celda nueva)**: *cobertura del ledger* — % de decisiones con `merge_status ≠ unknown` (campo `summary.coverage`, obtenible con `aitl adr status --json`), medible retroactivamente sobre los 75 ADRs reales del harness y sobre el lab raytracer (rama única `curso` ⇒ se espera 100% `trunk`) — evidencia de trazabilidad (mantenibilidad ISO 25010) del artefacto.
- **Métrica secundaria candidata a `tab:metrics` (decide SPEC-10)**: *lead time de decisión* — primer `merge_checked_at` que la vio merged menos `created_at`; proxy del costo de coordinación. Si SPEC-10 no la adopta, esta spec queda como **capacidad del artefacto sin compromiso evaluativo** (precedente roles/H11): responde al dolor #1 (amnesia de decisiones) reforzando el cap. 2 (Implicaciones) sin exigir re-correr celdas.

### Riesgos y mitigaciones

- **Squash/rebase rompen ancestry** → pasada `cherryEquivalent` (patch-id) los recupera como `merged_squash`; si el patch cambió al resolver conflictos, cae honesto a `unmerged`/`unknown` con `evidence` visible — nunca un falso `merged`.
- **Refs locales desactualizadas** (el estado es tan fresco como el último fetch) → `merge_checked_at`/`merge_checked_sha` siempre visibles + `--fetch` opt-in + el hook post-merge refresca en cada merge local; comparación contra remoto queda explícitamente fuera de alcance.
- **Contaminar el versionado append-only** → regla dura de `$set` directo, `merge_*` fuera de `ADR_CONTENT_FIELDS`, y el test de F2 la fija en CI.
- **Decisiones históricas sin procedencia** (previas a 0028/0049) → `unknown` masivo al inicio; mitigación: `aitl adr backfill` + regla `branch == trunk ⇒ trunk`.
- **Repos sin `path` o sin git** (CI, contenedor, MCP remoto) → contrato never-throw heredado de `util/git.ts`: degrada a `unknown`, jamás rompe sync/hydrate/record_decision.
- **Coste de git vivo** → dedupe por refs únicas, `refresh` opt-in, caché como camino por defecto; hydrate y API web jamás ejecutan git.
- **Canario RBAC olvidado** → el `deepEqual` de rbac.test.ts:64 falla si `decision_status` no entra en ambas listas: el canario es la mitigación.

### Dependencias

- **Ninguna dura**: implementable primera, solo puntos de extensión existentes (campos Mongoose opcionales, `server.tool`+`runLogged`+`TOOL_RBAC`, subcomandos Commander).
- **SPEC-03 (sintesis)**: el gate de cierre puede citar `HydrateResult.unlanded` en la síntesis final («esta sesión dejó N decisiones sin aterrizar») y componer `--fail-unmerged` como verifier — opcional, no bloqueante.
- **SPEC-09 (telemetry)**: `aitl session show` enlaza asientos del ledger tocados por el run (evento `decision` ya emitido por `record_decision`, server.ts:783-789, + el nuevo `decision_landed`).
- **SPEC-06 (multiagent)**: los worktrees crean ramas efímeras; su cleanup debe correr `branch sync` para que el ledger las liquide (esta spec como consumidor citado).
- **AACL (ADR proposed, por referencia)**: `decision_landed` viaja hoy en pull por `coord_events`; con AACL se empuja por SSE sin cambios aquí. ADR-0070 (repomap) no aplica.
