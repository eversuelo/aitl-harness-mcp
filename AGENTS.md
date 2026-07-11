# Agent operating contract (AITL) — aitl-js

> Contrato **durable** para cualquier agente de IA (Claude Code, Cursor, Codex, o el
> propio loop `runAgent`) que trabaje en este repositorio. El servidor MCP **`aitl-js`**
> es la fuente de verdad — no tu memoria en contexto. Regenerado y ampliado en la
> sesión de siembra 2026-07-11 (verificación de inyección + registro + router).

## Identidad del proyecto

| Campo | Valor |
|---|---|
| Project key canónico (MCP) | `aitl-js` |
| Project hash | `79cdb3578a8f619c` (`sha256("aitl-js")[:16]`) |
| Software (catálogo) | `aitl-js` → projects `["aitl-js"]` |
| Repo (sub-scope) | `AITL-Harness-JS` |
| Marcador en disco | `.aitl/project.json` (ADR-0063) |

Toda llamada a tools del MCP `aitl-js` lleva `project: "aitl-js"`. Nunca `AITL-Harness`,
`AITL-Harness-JS` ni variantes: fragmentan la historia.

## Antes de CADA decisión no trivial — consulta el MCP

1. `search_memory` — recall semántico de memoria/notas del proyecto.
2. `list_decisions` — ADRs ya tomadas (no contradigas una aceptada; si debes, supersédela).
3. `get_repomap` / `get_module_map` / `get_module_brief <dir>` — cuando toque estructura de código.
4. `get_skill(project="aitl-js", name="skill-router")` — al iniciar una tarea no trivial:
   enruta a la skill/rol/agente correcto (mapa completo en `docs/MAPA-SKILLS.md`).

Si el MCP y tus supuestos discrepan, **gana el MCP** — o expón el conflicto.

## Después de decidir / aprender — persístelo

1. `record_decision` — cada decisión arquitectónica es un ADR (Context/Decision/Consequences).
   El id es el **next-free leído de la colección `decisions` al momento de escribir**
   (skill `adr-ledger-reconcile`, scope `__global__`); jamás lo pinnees en docs.
2. `write_memory` — hechos durables, hallazgos y gotchas (slug estable; `type`:
   user | feedback | project | reference; tags `component:<dir>`, links `[[slug]]`).
3. `record_prompt` — el prompt/instrucción que condujo el trabajo (sesión reconstruible).
4. `aitl sync --pull --project aitl-js` — espeja ADRs y memoria a `docs/adr/` + `.aitl/`.

El procedimiento completo de cierre está codificado en la skill **`memoria-sesion`**.

## Registro: agents · roles · skills (colecciones del MCP)

**Agents** (colección `agents`, `metadata.kind ≠ role`) — briefs operativos que el loop
inyecta vía `routeSkills` bajo `## Project agents (…)`:

| Agent | Para qué |
|---|---|
| `harness-engineer` | Implementación en este repo: conventions, gates y verify obligatorios |

**Roles de ingeniería** (misma colección, `metadata.kind = "role"`; H11/ADR-0033) —
**opt-in** con `aitl run --roles a,b` o `aitl review <target> --roles a,b`; nunca se
auto-seleccionan:

| Rol | Modo | Severidad | denyGlobs / foco |
|---|---|---|---|
| `security` | gate | blocking | `*.env`, `*.pem`, `*id_rsa*`, `**/secrets/**` |
| `architect` | gate | blocking | consistencia con ADRs, límites de módulo |
| `qa` | pair | advisory | cobertura, edge cases, regresiones |
| `devops` | review | advisory | deploy, CI/CD, observabilidad, rollback |
| `devsecops` | review | advisory | seguridad del pipeline + operabilidad |

> Nota de fidelidad (verificado 2026-07-11): el modo `pair` hoy se ejecuta **igual que
> `review`** (una crítica al cierre del run); el acompañamiento continuo por edición y
> el campo `triggers` aún no están cableados (`src/orchestration/graph.ts:774`).

**Skills** (colección `skills`) — enrutadas por relevancia al prompt (máx. 3, ~6000
chars) en cada `aitl run`/`chat`/`orchestrate`/`run_agent`:

| Skill | Scope | Para qué |
|---|---|---|
| `skill-router` | `aitl-js` | Meta: enruta la tarea a la skill/rol/agente correcto |
| `memoria-sesion` | `aitl-js` | Cierre de sesión: grabar cada aprendizaje en el MCP |
| `repo-indexer` | `aitl-js` | Refrescar repo map + memoria + ADRs (`index_repo`) |
| `definition-builder` | `aitl-js` | Crear/actualizar skills y agentes (`build_definition`) |
| `adr-ledger-reconcile` | `__global__` | Reconciliar numeración de ADRs (cargar EXPLÍCITO: el router no enruta `__global__`) |

## Mapa de inyección (qué contexto llega por cada superficie)

| Superficie | memoria/ADRs/conventions/repomap (`hydrate`) | skills | agents | roles |
|---|---|---|---|---|
| Loop interno: `aitl run`/`chat`/`orchestrate`, MCP `run_agent` | ✅ en `system` | ✅ | ✅ | opt-in `--roles` (CLI; `run_agent` MCP no los expone) |
| Host externo: `aitl run-host` (Claude Code/Codex) | ✅ prepend al prompt (`--no-hydrate` = C0) | ❌ | ❌ | ❌ |
| Hook `aitl hydrate` (UserPromptSubmit) | ✅ stdout | ❌ | ❌ | ❌ |

`aitl run --bare` = condición C0: apaga hydrate+skills+gates de una vez.

## Quality gates (qué te frena y qué pasa si falla)

| Gate | Falla ⇒ |
|---|---|
| `PermissionGate` (deny-paths default, roles gate, `--ask`) | la tool NUNCA corre; `[denied by gate] <razón>` vuelve al modelo; evento `gate` |
| `--verify-cmd` / verifiers | feedback como turno user + ventana fresca; agotado ⇒ `stop_reason: verify_exhausted`, `verified: false` |
| Budgets `--budget-tokens/--budget-ms` | un turno final sin tools; `stop_reason: budget` |
| Stall detector | 1er strike feedback correctivo; 2do ⇒ `stop_reason: stalled` |
| Council (quórum/anonimato/juez) | reintento único citando el error; luego no-voto o error del comando |

## Conventions

- Always pass `project: "aitl-js"` on every aitl-js MCP call; never invent project-key variants.
- You must run `npm run verify` (typecheck + full test suite) before claiming any change done.
- Never touch or expose secrets (`.env`, `*.pem`, `*id_rsa*`, `**/secrets/**`); the security role gate vetoes them.
- Architectural changes must be recorded as an ADR with the next-free id read from the `decisions` collection at write time; never pin ADR numbers in docs.
- Always close a working session by persisting each learning: one `write_memory` per finding, plus `record_prompt` for the driving instruction (skill `memoria-sesion`).
- After recording ADRs or memory, always mirror durable state with `aitl sync --pull --project aitl-js`.
- Prefer updating an existing memory/ADR over creating a near-duplicate.
- Keep new docs and CLI help in Spanish; keep injected prompt preambles and convention rules in English.

## Reglas de dedo

- **Recall antes de razonar.** Un `search_memory` de 1 segundo vale más que re-derivar contexto.
- **Una decisión → un ADR.** Pequeños y append-only.
- **No dupliques.** Actualiza la memoria/decisión existente en vez de crear una casi-copia.
- **Escopa todo** al project `aitl-js`.

## Referencia rápida (CLI equivalentes)

```bash
aitl search "<query>" --project aitl-js           # recall semántico
aitl adr-sync --dir docs/adr --project aitl-js    # espejar ADRs a Mongo
aitl sync --pull --project aitl-js                # espejar Mongo → docs/adr + .aitl/
aitl role gate-check <path> --role security --project aitl-js   # probar el veto determinista
aitl run "<task>" --project aitl-js --verify-cmd "npm run verify" --roles security,architect
aitl ui --project aitl-js                         # explorar/editar memorias en la web UI
```
