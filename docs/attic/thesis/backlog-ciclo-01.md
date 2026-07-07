# AITL-Harness-JS — Backlog de Tareas · Ciclo 01

> **Qué es este documento.** El backlog ejecutable del Ciclo 01 bajo *spec-driven development* + ADR.
> Primero las tareas que **complementan** el harness (cierran lo que ya existe a medias) y después las que lo
> **evolucionan** (capas nuevas, con foco en *roles tipo pair-programming*).
> Cada tarea de núcleo de tesis produce al menos una ADR. Este doc está pensado para vivir en `docs/`.

---

## 0. Método cíclico (SDD + ADR)

El ciclo se repite por cada tarea o grupo de tareas:

```txt
1. SPEC      → objetivo + contrato + criterios de aceptación   (este doc)
2. DECISIÓN  → si hay >1 enfoque, se elige con tabla de trade-offs
3. ADR       → se registra la decisión (Context / Decision / Consequences + rationale)
4. BUILD     → implementación production-ready (TS estricto, Zod, logs estructurados)
5. VALIDA    → se cumplen los criterios; se emiten eventos a la colección `events`
6. EVIDENCIA → lo que el ciclo aporta a la tesis (artefacto + conocimiento de diseño)
```

**Regla de oro DSR:** ninguna tarea de tesis se cierra sin (a) su ADR y (b) una línea de *conocimiento de diseño* generalizable. El artefacto sin el conocimiento es solo código.

### Convenciones de etiquetado

| Etiqueta | Significado |
|---|---|
| 🎓 | **Tesis-núcleo** — defendible, dentro del alcance acotado |
| 🚀 | **Producto-roadmap** — valioso, pero *después* de la tesis |
| 🟡 | **Frontera** — mínimo viable para tesis; el resto es roadmap |
| S / M / L | Esfuerzo aproximado (≤1 día / 2-4 días / 1-2 semanas) |

### Numeración ADR

> ⚠️ **Los números `ADR-00NN` por tarea de abajo son ILUSTRATIVOS (plan), no un contrato.** No se
> pinnean: cada ADR toma el **next-free real** del ledger (`decisions` en Atlas) en el momento de
> BUILD. Estado verificado **2026-06-28**: ledger contiguo **0001–0024** → **next-free `0025`** (el
> `0024` lo tomó la ADR de RBAC, no C1). El contrato de numeración de cierre vive en
> `docs/ciclo-01-definition-of-done.md`, no aquí. Tareas puramente operativas (tests, `doctor`) **no**
> emiten ADR.

### Plantilla de tarea (contrato fijo)

```txt
ID · Título                          [🎓/🚀]  [Complementar/Evolucionar]  [S/M/L]
Objetivo        — 1-2 líneas
Por qué         — valor para tesis y/o producto
Depende de      — IDs previos
Contrato        — colecciones / tools MCP / comandos CLI / schemas
Aceptación      — checklist verificable
ADR             — número propuesto + título
Diseño (DSR)    — conocimiento generalizable (si aplica)
```

---

# TIER 1 — COMPLEMENTAR el harness

> Estas tareas **no agregan capas nuevas**. Vuelven *verdaderas de punta a punta* las afirmaciones que el
> harness ya hace (agnosticismo de modelo, trazabilidad). Hoy las afirmas; aquí las cierras.

---

## C1 · Colección `models` + binding `agent ↔ host ↔ model`  🎓 · Complementar · M

**Objetivo.** Hacer del **modelo un dato de primera clase** (colección `models`) y permitir que cada agente/rol especifique *en qué host corre* y *con qué modelo se alimenta*. Hoy tienes colecciones `agents` y `skills` (DefinitionStore); falta la tercera pata, `models`, y el binding.

**Por qué.** Es tu petición explícita ("colección skill, agent y model para especificar el host del agente") y es el **corazón del agnosticismo por construcción**: si el modelo es dato consultable (no config suelta), habilitas router (E5), contabilidad de costos y *reproducibilidad* (fijar agente+modelo+contexto → replay).

**Depende de.** —

**Contrato.**

`models` (nueva colección) — `ModelSpec`:

```ts
// src/contracts.ts
import { z } from "zod";

export const ModelSpecSchema = z.object({
  id: z.string(),                         // id namespaced de OpenRouter: "anthropic/claude-3.5-sonnet"
  family: z.enum(["claude", "gpt", "gemini", "deepseek", "qwen", "other"]),
  provider: z.literal("openrouter"),      // único gateway hoy (OpenAI-compatible)
  contextWindow: z.number().int().positive(),
  capabilities: z.object({
    tools: z.boolean(),
    vision: z.boolean(),
    jsonMode: z.boolean(),
  }),
  cost: z.object({                        // por millón de tokens (habilita E5 y costos)
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
  }),
  tierHint: z.enum(["cheap", "balanced", "frontier"]),  // pista para el router
  enabled: z.boolean().default(true),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;
```

Extensión del `AgentDefinition` (reusa la colección `agents`, **no** crea otra):

```ts
export const HostKind = z.enum(["model", "claude-code", "codex", "antigravity"]);

// se añade a la definición existente de agente:
export const AgentBindingSchema = z.object({
  host: HostKind.default("model"),        // cómo se ejecuta
  model: z.string().optional(),           // ref a models.id (el "motor")
});
```

**Resolución (regla del binding):**

| `host` | Cómo se resuelve el modelo | Trazabilidad |
|---|---|---|
| `model` | El harness conduce el loop; usa `model` ref vía OpenRouter | `model` exacto en el run |
| `claude-code` / `codex` / `antigravity` | El host tiene su propio loop; `model` se pasa como flag **si el host lo soporta**, si no se registra como metadata | `host` + `model` declarado quedan en el run |

- Tools MCP: `write_model`, `get_model`, `list_models`, `search_models`, `delete_model` (mismo patrón que `write_skill`/`write_agent`).
- CLI: `aitl model {add,list,show,rm}`.
- `init-db` y `COLLECTIONS` incluyen `models`.

**Aceptación.**
- [ ] `models` creada con índices escalares/texto; `COLLECTIONS` y `init-db` la cubren.
- [ ] `AgentDefinition` acepta `host` + `model`; validación Zod estricta.
- [ ] `runAgent`/`runOnHost` resuelven el modelo según la tabla y lo persisten en el run.
- [ ] Tools MCP `*_model` operativas y visibles en el cliente MCP.
- [ ] Un agente seed (`backend-architect`) con `host: claude-code, model: anthropic/claude-3.5-sonnet` corre y deja el binding en su run.

**ADR.** `ADR-0024 — Model specs como dato de primera clase y binding agent↔host↔model`.

**Diseño (DSR).** *Tratar la selección de modelo como dato consultable (no configuración) convierte el agnosticismo en propiedad estructural y habilita enrutamiento, costos y reproducibilidad sin tocar el loop.*

---

## C2 · Dimensión `actor` mínima — procedencia ("quién ordenó")  🎓 · Complementar · S

**Objetivo.** Que cada `run`, `event`, `prompt` y escritura de memoria/decisión lleve **quién la originó**. Hoy todo es anónimo (single-user `~/.aitl/config.json`).

**Por qué.** La trazabilidad ya está instrumentada (colección `events`), pero sin actor no responde la pregunta central de la tesis: *¿esto lo pidió un humano o un agente, y cuál?*. Es barato y transversal: desbloquea casi todo lo demás.

**Depende de.** —

**Contrato.**

```ts
export const ActorSchema = z.object({
  id: z.string(),                                  // estable: email git o "user:uuid" o "agent:<name>"
  type: z.enum(["human", "agent", "subagent", "system"]),
  display: z.string().optional(),
  source: z.enum(["explicit", "mcp-token", "git", "os", "system"]),
});
export type Actor = z.infer<typeof ActorSchema>;
```

**Resolución por precedencia** (reusa tu patrón `process.env > config > defaults`):

| Fuente | Origen | Cuándo |
|---|---|---|
| `--actor` / `AITL_ACTOR` | flag o env | CI, scripts, override |
| `mcp-token` | mapeo token→usuario en MCP-HTTP | agentes remotos |
| `git` | `git config user.email` | trabajo local en repo |
| `os` | `os.userInfo().username` | fallback |
| `system` | el harness | sub-agentes/synthesis automáticos |

- `RunAgentOpts` gana `actor: Actor`. En `orchestrate`, los sub-runs **heredan** el actor del master y marcan `spawnedBy: parentRunId` (enriquece el evento `spawn` que ya emites).
- Persistir `actorId` en `runs`, `events`, `prompts`, y en `write_memory`/`record_decision`.

**Aceptación.**
- [ ] `Actor` resuelto por precedencia y validado con Zod.
- [ ] `actorId` presente en runs, events, prompts y escrituras de memoria/decisión.
- [ ] Sub-runs de `orchestrate` heredan actor + `parentRunId`.
- [ ] Una corrida humana y una de sub-agente quedan distinguibles en `events`.

**ADR.** `ADR-0025 — Dimensión de actor para procedencia`.

**Diseño (DSR).** *Adjuntar un actor tipado a cada evento del loop transforma un log de ejecución en un registro de procedencia auditable; la identidad se resuelve por capas para no acoplarse a un único proveedor de auth.*

---

## C3 · Captura de contexto Git (snapshot read-only)  🎓 · Complementar · S

**Objetivo.** Anclar cada run a un punto del VCS (`branch`, `headSha`, `dirty`) y mapear `remote → project`. Sin git enriquecido todavía: solo *lectura* al iniciar.

**Por qué.** Resuelve "identificar el proyecto y su actualización" con el mínimo acoplamiento. Es la base de toda trazabilidad de versión y de la futura capa git (E-roadmap).

**Depende de.** —

**Contrato.**

```ts
export const GitContextSchema = z.object({
  remote: z.string().optional(),     // git@github.com:eversuelo/...
  branch: z.string(),
  headSha: z.string(),
  dirty: z.boolean(),                // ¿había cambios sin commitear al iniciar?
});
export type GitContext = z.infer<typeof GitContextSchema>;
```

- Snapshot al inicio de `runAgent`/`runOnHost`, persistido en el run.
- Mapeo `remote → project`: si el cwd es un repo con remote conocido, el harness **deduce** `project` (deja de exigir siempre `--project`).
- Métrica derivada: "N commits desde el último run de IA" (compara `headSha` vs. el del último run del proyecto).

**Aceptación.**
- [ ] Snapshot git en cada run (incluye `dirty`).
- [ ] `remote → project` resuelto cuando hay remote; `--project` sigue funcionando como override.
- [ ] La UI/CLI puede mostrar "commits desde el último run".

**ADR.** `ADR-0026 — Captura de contexto Git (snapshot al inicio del run)`.

**Diseño (DSR).** *Un snapshot de VCS por run, sin escritura ni hooks, basta para hacer cada ejecución de IA reproducible y diferenciable; el enriquecimiento (diff/PR/webhooks) es aditivo y no debe bloquear esta base.*

---

## C4 · Exponer la traza vía MCP + entidad `task` mínima  🎓 · Complementar · M

**Objetivo.** Ya **grabas** los eventos correctos (`loop_iter`, `tool_call`, `gate`, `spawn`, `synthesis`, `hydrate`, `retry`…). Falta **exponerlos** por MCP y materializar el árbol de ejecución como `task`.

**Por qué.** Cierra de verdad tu punto "el harness como Tool MCP de trazabilidad": hoy un agente puede leer memoria pero **no su propia historia causal**. Y convierte la trazabilidad de *derivada de eventos* a *entidad consultable*.

**Depende de.** C2 (actor en eventos), C3 (git en runs).

**Contrato.**

`tasks` (nueva colección) — agrega lo que `orchestrate` hoy produce implícito vía `spawn`:

```ts
export const TaskSchema = z.object({
  id: z.string(),
  project: z.string(),
  goal: z.string(),
  status: z.enum(["planned", "running", "done", "failed", "cancelled"]),
  actorId: z.string(),                 // quién la ordenó (C2)
  runIds: z.array(z.string()),         // runs (master + sub-agentes)
  rootRunId: z.string().optional(),
  gitContext: GitContextSchema.optional(),  // (C3)
  createdAt: z.string(),
  endedAt: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;
```

Tools MCP nuevas (además de `graphify`, que es del estado durable, no de la ejecución):

| Tool | Propósito |
|---|---|
| `get_run_trace` | eventos ordenados de un `run_id` |
| `list_runs` | runs filtrables por `project`, `actor`, `status`, `since` |
| `get_task_tree` | árbol master → sub-agentes (vía `spawn`) de una task |

**Aceptación.**
- [ ] `tasks` creada; `orchestrate` materializa una task con su árbol de runs.
- [ ] `get_run_trace`, `list_runs`, `get_task_tree` operativas por MCP.
- [ ] Un cliente MCP puede reconstruir "esta orden → estos sub-agentes → estas tool calls".

**ADR.** `ADR-0027 — Exposición de traza por MCP y entidad Task`.

**Diseño (DSR).** *Separar el "estado durable" (memoria/símbolos, vía `graphify`) de la "historia de ejecución" (eventos/task tree) da dos grafos complementarios: uno de conocimiento, otro de procedencia. La tesis necesita ambos.*

---

## C5 · Round-trip de skills/agents (import/export como archivos)  🟡 · Complementar · S

**Objetivo.** Cerrar el ciclo archivo↔DB para definiciones: **importar** un `AGENTS.md`/`.claude/skills/*` externo *dentro* del DefinitionStore y **volcar** las definiciones guardadas *a* archivos versionables. Hoy exportas el *canon/reglas* (adapters) e importas convenciones (`parseAgentsMd`), pero el round-trip de las *definiciones* no está completo.

**Por qué.** Portabilidad real de skills/agents entre herramientas y máquinas; alimenta los adapters de E-roadmap (Claude/Codex).

**Depende de.** C1 (para que las definiciones incluyan `host`+`model`).

**Contrato.**
- CLI: `aitl skill import <path>` / `aitl skill export <name> --out <dir>`; ídem `agent`.
- Formato canónico de ida y vuelta sin pérdida (incluye `host`/`model`/`skills`).

**Aceptación.**
- [ ] Importar un skill externo lo deja consultable por `search_skills`.
- [ ] Exportar un agent produce un archivo que re-importa idéntico (round-trip sin pérdida).

**ADR.** `ADR-0028 — Portabilidad (round-trip) de definiciones agent/skill`.

---

## C6 · Endurecimiento operativo (seguridad + calidad)  🎓 · Complementar · M

**Objetivo.** Cerrar tres agujeros que muerden en demo/producción y que tu perfil DevOps va a exigir: aislamiento de ejecución, control de concurrencia y diagnóstico.

**Por qué.** El `ShellTool` hoy corre sin aislamiento — en un caso multi-tenant (Schoolar) eso es un riesgo real, no teórico. `orchestrate` lanza N sub-agentes en paralelo sin límite explícito.

**Depende de.** —

**Contrato.**
- **Aislar `ShellTool`:** al menos confinamiento de `cwd` y allowlist de comandos; en modo multi-tenant, contenedor por run (gancho, no obligatorio en Ciclo 01).
- **Concurrencia:** `orchestrate` gana `maxConcurrency` + rate-limit; respeta presupuesto de tokens.
- **`aitl doctor`:** valida Mongo, MCP, hosts disponibles, embeddings y config en un comando.
- **Tests:** unit de `MemoryStore`, `DefinitionStore`, `PromptStore` y de la resolución de C1/C2/C3.

**Aceptación.**
- [ ] `ShellTool` no escapa del `cwd` permitido; comandos fuera de allowlist se auditan/bloquean.
- [ ] `orchestrate` respeta `maxConcurrency`.
- [ ] `aitl doctor` reporta verde/rojo por subsistema.
- [ ] Tests de stores en verde en CI.

**ADR.** `ADR-0029 — Aislamiento de ShellTool y límites de concurrencia` (las partes de tests/doctor son operativas, sin ADR).

**Diseño (DSR).** *En un harness que ejecuta código generado, el aislamiento del shell y el límite de concurrencia son requisitos de seguridad del artefacto, no optimizaciones; deben ser gates deterministas, no acuerdos verbales con el agente.*

---

# TIER 2 — EVOLUCIONAR el harness

> Aquí sí agregamos capas. El **centro de este ciclo de evolución son las capas de rol con semántica de
> pair-programming**. Punto clave: **se construyen componiendo primitivas que ya tienes** (definiciones +
> skills + gates + hooks + PhaseGate), no desde cero.

---

## 2.A · Capas de Rol / Pair-Programming  (tu petición explícita)

### E1 · Modelo de `Role` componible  🎓 · Evolucionar · M

**Objetivo.** Un **Rol** = `persona + skills[] + perfil de permisos (gates) + binding (host+model) + modo`. Se almacena en la colección `agents` con un discriminador `kind` (reusa DefinitionStore; **no** nueva colección).

**Por qué.** Los roles (DevOps, Security, DevSecOps…) no son features sueltas: son *composiciones* de tus primitivas con una **lente de revisión**. Modelarlos como dato componible es lo que los vuelve reutilizables y agnósticos de modelo.

**Depende de.** C1 (binding), C4 (para que los roles emitan a la traza).

**Contrato.**

```ts
export const RoleMode = z.enum(["review", "pair", "gate"]);

export const RoleSchema = z.object({
  kind: z.literal("role"),                 // discrimina vs. "worker" en la colección agents
  name: z.string(),                        // "devops", "security", "devsecops", "qa", "architect"
  lens: z.string(),                        // foco de revisión (prompt de persona)
  mode: RoleMode,
  severity: z.enum(["advisory", "blocking"]),
  triggers: z.array(z.string()),           // eventos/paths que lo activan (p.ej. "Edit", "Write", "**/auth/**")
  skills: z.array(z.string()),             // refs a skills
  binding: AgentBindingSchema,             // host + model (C1)
});
export type Role = z.infer<typeof RoleSchema>;
```

**Aceptación.**
- [ ] `Role` validado con Zod; persiste en `agents` con `kind:"role"`.
- [ ] CRUD por las tools existentes `*_agent` (filtrables por `kind`).
- [ ] Un rol resuelve su modelo vía C1.

**ADR.** `ADR-0030 — Rol como overlay componible (persona+skills+gates+binding+modo)`.

**Diseño (DSR).** *Un "rol de ingeniería" se puede expresar como composición declarativa de primitivas existentes; esto evita un runtime paralelo y mantiene el agnosticismo de modelo en cada rol.*

---

### E2 · Modos de ejecución de rol  🎓 · Evolucionar · L

**Objetivo.** Implementar los tres modos que dan la semántica de pair-programming, reusando tus mecanismos actuales.

**Por qué.** "Pair-programming" implica colaboración **continua**, no una revisión única al final. Cada modo tiene costo y acoplamiento distintos.

**Depende de.** E1, C4, C6 (gates).

**Contrato — comparación de modos:**

| Modo | Semántica | Implementación (reusa) | Costo | Cuándo |
|---|---|---|---|---|
| `review` | Revisa en *checkpoints* (fin de fase, pre-PR) | Lee diff/transcript → emite evento `review` | Bajo | Default para la mayoría de roles |
| `pair` | **Continuo**: opina antes/después de cada edición | Hooks `PreToolUse`/`PostToolUse` sobre Edit/Write/Shell (tu módulo `hooks/` + `ToolRegistry.onDeny`) | Medio/Alto | Roles que deben acompañar (QA, Security) |
| `gate` | **Bloqueante**: veta cambios que violan su lente | `PermissionGate` / `denyPathsGate` (ya existen) | Bajo | Security/DevSecOps/Architect |

- Nuevos eventos: `review`, `role_veto`, `deliberation` (a la colección `events`, con `actorId` = `agent:<rol>`).
- Modo `pair` produce comentarios *advisory* o *blocking* según `severity` del rol.

**Aceptación.**
- [ ] Los tres modos operan y emiten sus eventos a la traza (visibles vía `get_run_trace`).
- [ ] Modo `gate` realmente bloquea (p. ej. un diff que introduce un secreto).
- [ ] Modo `pair` se dispara en los `triggers` declarados, no en todo.

**ADR.** `ADR-0031 — Modos de ejecución de rol (review / pair / gate)`.

**Diseño (DSR).** *El "pair-programming" entre agentes se reduce a tres patrones de acoplamiento al loop (checkpoint, hook continuo, gate bloqueante); nombrarlos y medir su costo es conocimiento de diseño reutilizable.*

---

### E3 · Catálogo inicial de roles (seed)  🎓 · Evolucionar · M

**Objetivo.** Definiciones seed listas para usar. Cada una es un `Role` (E1) con su modo (E2).

**Por qué.** Concreta tu petición (DevOps, CyberSecurity, DevSecOps, etc.) y da material para evaluar en Schoolar.

**Depende de.** E1, E2.

**Contrato — catálogo:**

| Rol | Lente | Modo | Severidad | Conecta con |
|---|---|---|---|---|
| **DevOps** | deploy, CI/CD, observabilidad, costo, IaC, rollback | `review` | advisory | tu mentalidad DevOps; skill `deploy-checklist` |
| **CyberSecurity** | secretos, authz/authn, inyección, CVEs, cripto | `gate` (secretos) + `review` | blocking | tu gate `deny .env/keys` actual |
| **DevSecOps** | seguridad-en-pipeline + deployability | `gate` en pre-PR/pre-deploy | blocking | composición Security(blocking)+DevOps(advisory) |
| **QA** | cobertura, edge cases, regresiones | `pair` | advisory | tu `PhaseGate` (TDD red→green) |
| **Architect** | consistencia con ADRs, límites de módulo | `gate` | blocking | **tu `TODO.md`: guardia anti-regresión de ADRs (scope `components`)** |

> El rol **Architect** *es* la guardia anti-regresión que ya planeas en `TODO.md`: cuando un diff toca un componente, jala las ADRs ligadas (campo `components`) y veta si las contradice. No es trabajo nuevo: es formalizar el que ya ibas a hacer. (Esa ADR de scope-de-componente del `TODO.md` tomará el id libre que corresponda cuando se registre — ya no es 0024, que ahora es C1.)

**Aceptación.**
- [ ] Los 5 roles existen como definiciones seed re-importables (C5).
- [ ] Cada rol corre en su modo y deja evidencia en la traza.
- [ ] Architect bloquea un cambio que contradice una ADR de su `components`.

**ADR.** `ADR-0032 — Catálogo inicial de roles de ingeniería`.

---

### E4 · Bucle de deliberación propose → critique → synthesize  🎓 · Evolucionar · L

**Objetivo.** Para tareas con varios roles en `pair`, orquestar una deliberación estructurada: el worker **propone**, los roles **critican** (cada uno con su lente), y se **sintetiza**.

**Por qué.** Es tu patrón `plan-council` aplicado a **roles** en vez de a modelos. Da el efecto "varios pares revisando a la vez" con trazabilidad de quién objetó qué.

**Depende de.** E2, E3.

**Contrato.**
- Ronda: `propose` (worker) → `critique[]` (N roles) → `synthesize` (lead).
- Cada paso emite evento `deliberation` con `actorId` del rol y su veredicto.
- Reusa el agnosticismo de C1: roles pueden usar modelos distintos (un Security barato, un Architect frontier).

**Aceptación.**
- [ ] Una tarea multi-rol produce una traza `propose→critique→synthesize` reconstruible.
- [ ] Las objeciones quedan atribuidas por rol/actor.
- [ ] Funciona con roles sobre modelos heterogéneos.

**ADR.** `ADR-0033 — Deliberación multi-rol (propose/critique/synthesize)`.

**Diseño (DSR).** *La deliberación multi-modelo y la multi-rol son el mismo patrón sobre distinto eje (motor vs. lente); unificarlos reduce superficie y refuerza el agnosticismo.*

---

## 2.B · Selección y enrutamiento

### E5 · `AITL Auto Router` (reglas → embeddings → modelo chico)  🟡 · Evolucionar · L

**Objetivo.** Elegir automáticamente **rol(es), host y modelo** para una tarea, en escalera de costo creciente.

**Por qué.** Sin router, el agnosticismo es manual. Con router (barato primero), el harness *decide* qué motor y qué lente aplicar — y eso es demostrable.

**Depende de.** C1, E1-E3.

**Contrato — escalera:**

| Nivel | Mecanismo | Costo | Reusa |
|---|---|---|---|
| 1 | Reglas determinísticas (palabras clave → rol/host) | $0 | — |
| 2 | Embeddings locales (tarea vs. descripción de roles/skills) | $0 | `@xenova/transformers` que ya tienes |
| 3 | Modelo chico (desempate opcional) | bajo | C1 (`tierHint: cheap`) |

- CLI: `aitl route "<tarea>"` (explica) y `aitl auto "<tarea>"` (ejecuta).
- Tools MCP: `select_agents`, `explain_routing`.
- Salida con `confidence`, `lead`, `agents[]` (rol+host+model+sandbox).

**Aceptación.**
- [ ] Nivel 1 y 2 funcionan sin llamadas de pago.
- [ ] `aitl route` explica por qué eligió cada rol/modelo.
- [ ] La elección queda en la traza (auditable).

**ADR.** `ADR-0034 — Router por escalera de costo (reglas/embeddings/modelo)`.

**Diseño (DSR).** *Enrutar por costo creciente (reglas→embeddings locales→modelo) mantiene el harness barato por defecto y hace explícita la decisión de selección, requisito de auditoría.*

---

## 2.C · Memoria y alcance

### E6 · Agrupamiento sobre `project` (grupos-tag)  🎓 · Evolucionar · M

**Objetivo.** "Memoria general" entre proyectos sin la cirugía de una jerarquía org/workspace. Un proyecto pertenece a `groups[]`; al hidratar, se amplía la búsqueda a los miembros del grupo con peso menor.

**Por qué.** Es el punto medio que da el ~80% del valor por el ~20% del costo. La jerarquía completa (org→workspace→project) es 🚀 roadmap y debe ir como ADR propia por lo invasiva.

**Depende de.** —

**Contrato.**
- Campo `groups: string[]` en el registro de proyecto.
- `hydrate(project)` resuelve grupos y amplía vector/text search a miembros, con peso reducido para lo "heredado".

**Aceptación.**
- [ ] Hidratar el proyecto X jala memoria del grupo con peso menor.
- [ ] No rompe el scoping por `project` existente.

**ADR.** `ADR-0035 — Agrupamiento de proyectos por grupos-tag (recall compartido)`.

**Diseño (DSR).** *El recall compartido por tag entrega memoria cross-proyecto sin cambiar el contrato de scoping; la jerarquía dura solo se justifica si la tesis exige aislamiento multi-tenant real.*

---

## 2.D · Trazabilidad visual (la evidencia de la tesis)

### E7 · UI React de trazabilidad con mapas  🎓 · Evolucionar · L

**Objetivo.** La vista que pediste: **mapas y trazabilidad didáctica** del camino de los agentes. No es adorno — es **la contribución hecha imagen** para la defensa.

**Por qué.** Mostrar cómo viajó una orden (`humano → rol líder → sub-agentes → tool calls → archivos → commit → PR`) *es* el argumento de la tesis visualizado.

**Depende de.** C2, C3, C4 (la UI consume sus tools/endpoints).

**Contrato — vistas mínimas:**

| Vista | Contenido | Fuente |
|---|---|---|
| **Timeline de task** | orden → lead → sub-agentes → MCP calls → git changes → resultado | `get_task_tree`, `get_run_trace` |
| **Mapa / grafo** | `actor → rol → tool_call → archivo → commit → PR` (dirigido, navegable) | eventos + `graphify` como base |
| **Diff viewer** | archivo · run que lo cambió · rol que lo cambió · prompt que lo pidió · commit | `git_changes` (C3) + traza |
| **Registry** | roles, skills, models, agents del proyecto | colecciones C1/E1 |

- Reusa `server/api.ts` (ya proyecta `MemoryStore`); añade endpoints sobre `events`/`tasks`/`runs`.
- Grafo con React Flow o Cytoscape; filtro por `actor`/rol; timeline interactiva.

**Aceptación.**
- [ ] La timeline reconstruye una task real de Schoolar de punta a punta.
- [ ] El grafo navega `actor→rol→tool→archivo→commit` y filtra por rol.
- [ ] El diff viewer liga cada cambio a su prompt y su rol.

**ADR.** `ADR-0036 — UI de trazabilidad (timeline + grafo + diff viewer)`.

**Diseño (DSR).** *Visualizar procedencia como un grafo dirigido navegable (no como log plano) es lo que hace evaluable —y enseñable— la trazabilidad; la UI es instrumento de demostración, no accesorio.*

---

## 2.E · Frontera tesis/producto

### E8 · Work orders mínimas  🟡 · Evolucionar · M

**Objetivo.** Formalizar la "orden" por encima del run (quién pidió, con qué fuente: `ui|cli|mcp|github`). Versión mínima; la enterprise es roadmap.

**Por qué.** Da el nivel de agregación "orden de trabajo" útil para la UI y la evaluación, sin abrir RBAC ni multi-tenant todavía.

**Depende de.** C2, C4.

**Contrato.** `work_orders` (mínima): `title, prompt, source, orderedByActorId, status, taskIds[]`.

**Aceptación.**
- [ ] Una work order agrupa una o más tasks y queda atribuida a un actor.
- [ ] Visible en la UI (E7) como nodo raíz del timeline.

**ADR.** `ADR-0037 — Work orders (orden de trabajo mínima)`.

---

### E-roadmap · Fuera de alcance del Ciclo 01  🚀

Se documentan para **no perderlos**, pero son producto, no tesis-núcleo. Cada uno será su propia ADR en su ciclo:

- Git enriquecido: PR linkage, webhooks de GitHub, `git_commits`/`git_changes` completos.
- Contabilidad de costos/tokens por run/modelo/proyecto + presupuestos.
- Approval gates de humano (push, merge, migración DB, deploy prod).
- RBAC (Owner/Admin/Maintainer/Developer/Reviewer/Viewer/Agent/Auditor).
- Policy-as-code (`aitl.policy.yaml`) y jerarquía org→workspace→project.
- Audit log inmutable + export de *compliance bundle*.
- Adapters host completos para Copilot (vía GitHub Coding Agent + PRs — el más frágil; ver análisis previo).
- Exportador OpenTelemetry / Langfuse (opcional, sin dependencia dura).

---

# Apéndices

## A. Mapa de dependencias (qué desbloquea qué)

```txt
C1 (models+binding) ──┬─► E1 (Role) ──► E2 (modos) ──► E3 (catálogo) ──► E4 (deliberación)
                      └─► E5 (router)
C2 (actor) ───────────┬─► C4 (traza+task) ──► E7 (UI) ──► E8 (work orders)
C3 (git snapshot) ────┘
C6 (seguridad/calidad): transversal, no bloquea pero protege todo lo que ejecuta
E6 (grupos): independiente
```

## B. Secuencia recomendada del Ciclo 01

1. **C1** — models + binding *(habilita roles y router; es tu petición central)*
2. **C2** — actor *(barato, transversal)*
3. **C3** — git snapshot *(barato, base de versión)*
4. **C4** — traza por MCP + task *(cierra "harness como tool de trazabilidad")*
5. **E1 → E2 → E3** — roles componibles, modos, catálogo *(tu petición de capas pair-programming)*
6. **C6** — endurecimiento *(antes de meter más ejecución concurrente)*
7. **E7** — UI de trazabilidad *(la evidencia visual)*
8. **E4 / E5 / E6 / E8** — deliberación, router, grupos, work orders *(según tiempo)*

## C. Evidencia que produce este ciclo (DSR)

- **Artefacto:** harness con modelo-como-dato, procedencia por actor, traza navegable, y roles de ingeniería con semántica de pair-programming.
- **Conocimiento de diseño:** las líneas "Diseño (DSR)" de C1, C2, C4, E1, E2, E4, E5, E6, E7 — principios reutilizables aunque otro equipo no use tu código.
- **Validable en Schoolar:** una feature construida con roles activos vs. sin ellos, con la UI mostrando la diferencia en trazabilidad y en intervenciones de cada rol.

## D. Próximo ciclo (a definir contigo)

- Tipo de evaluación: **comparativa** (con/sin harness, métricas) vs. **demostrativa** — define la forma de las tareas de la fase final.
- Profundización del rol **Architect** ↔ tu guardia anti-regresión de ADRs (`TODO.md`).
- Primer adapter host completo (Claude o Codex) para exportar roles como `.claude/agents` / `.codex/agents`.
