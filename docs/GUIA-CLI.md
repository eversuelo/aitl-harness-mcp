# Guía de comandos `aitl` — software → project → repo → branch

Toda la superficie del CLI, validada contra `src/cli.ts`, organizada por el nivel de la
jerarquía del catálogo sobre el que opera cada comando. Para las opciones completas:
`aitl <comando> --help`.

## La jerarquía

```
software  (producto paraguas: agrupa projects)
└── project  (clave canónica de TODO el estado durable: memoria, ADRs, prompts, runs…)
    └── repo  (hoja del catálogo; sub-scope de datos: etiqueta símbolos y memoria)
        └── branch  (ramas git clasificadas por repo; alimentan el grafo de ramas)
```

- **`project` es la clave que importa.** Casi todos los comandos llevan `--project`; para
  este repo úsalo siempre como `aitl-js`. Resolución cuando se omite (ADR-0063):
  `--project` > `$AITL_PROJECT` > `.aitl/project.json` (búsqueda hacia arriba) > basename
  del cwd **con aviso**.
- **`software` y `repo`** son catálogo: organizan projects y etiquetan datos, no cambian el
  scope de la memoria.
- **`branch`** clasifica las ramas git de un repo (`main|develop|feature|…`) para el grafo
  estilo GitHub de la web UI.

---

## 0. Globales / infraestructura (sin scope de jerarquía)

| Comando | Qué hace |
|---|---|
| `aitl` / `aitl interactive` (alias `menu`) | Panel de control interactivo: supervisa MCP/UI, corre comandos; submenu **Chat ▸** (atajo `c`). |
| `aitl check-db` | Valida conectividad/auth de MongoDB (primario, luego fallback) y readiness RBAC. |
| `aitl init-db` | Crea colecciones, índices escalares/texto y los índices vectoriales de Atlas. |
| `aitl models [--json] [--detect [--env]]` | Muestra qué backends LLM están configurados, el activo y la cadena de fallback; `--detect` autodetecta el modelo cargado en LM Studio. |
| `aitl mcp [--http --host --port --path --socket --token]` | Arranca el servidor MCP (stdio por defecto; `--http` para clientes remotos). |
| `aitl ui [--project] [--api-port 4317] [--web-port 5317] [--no-web]` | Lanza la web UI de memoria (API HTTP + SPA Vite). |
| `aitl migrate-atlas <target-uri> [--from --from-db --to-db --collections --drop --dry-run]` | Copia una base a otro clúster MongoDB/Atlas (solo datos; corre `init-db` en el destino para los índices). |

### `aitl config` — perfil de configuración de usuario

| Subcomando | Qué hace |
|---|---|
| `config path` | Imprime la ruta de `~/.aitl/config.json`. |
| `config show [--secrets]` | Config efectiva (env > perfil > .env > archivo > defaults); secretos enmascarados. |
| `config export [--out <file>] [--secrets]` | Exporta la config efectiva como perfil JSON portable. |
| `config import <file> [--merge]` | Importa un perfil JSON a `~/.aitl/config.json`. |
| `config set <KEY> <valor> [--env]` | Fija una clave; `--env` la espeja también en `./.env`. |
| `config unset <KEY> [--env]` | Elimina una clave; `--env` la comenta en `./.env`. |
| `config profile list` | Lista perfiles con nombre (el activo marcado con `*`). |
| `config profile create <name> [--from-current]` | Crea un perfil (overlay vacío por defecto). |
| `config profile set <name> <KEY> <valor>` | Fija una clave dentro de un perfil. |
| `config profile show <name> [--secrets]` | Muestra las claves de un perfil. |
| `config profile use [name] [--none]` | Activa un perfil (o ninguno); aplica al siguiente arranque. |
| `config profile rm <name>` | Borra un perfil (rechaza borrar el activo). |

### `aitl user` — usuarios RBAC

| Subcomando | Qué hace |
|---|---|
| `user bootstrap` | Crea el usuario bootstrap configurado por env si no existe. |
| `user register --username --email --password` | Alta self-service; el primer usuario real queda `admin`. |
| `user verify --username --email --password` | Verifica credenciales contra el usuario almacenado. |
| `user list` | Lista usuarios (sin hashes). Solo root. |
| `user create --username --email --password [--role user]` | Crea un usuario (`root|admin|user|agent|auditor`). Solo root; auditado. |
| `user set-role --username --role` | Cambia el rol. Solo root; auditado. |
| `user disable --username [--enable]` | Deshabilita (o re-habilita) un usuario. Solo root; auditado. |

---

## 1. Nivel SOFTWARE

El software agrupa projects (p. ej. un producto con varios repos/servicios).

| Comando | Qué hace |
|---|---|
| `software add <name> [--display --desc --projects <lista> --tags]` | Crea/actualiza un software y sus projects miembro. |
| `software list [--tag]` | Lista softwares (más nuevos primero). |
| `software get <name>` | Muestra un software. |
| `software rm <name>` | Elimina un software del catálogo. |

```bash
aitl software add tesis --display "Tesis AITL" --projects aitl-js,aitl-raytracer
```

---

## 2. Nivel PROJECT

Aquí vive casi todo: la memoria, los ADRs, los prompts, los runs y los roles se scopean
por `--project`.

### Onboarding

| Comando | Qué hace |
|---|---|
| `init [--root .] [--project] [--software] [--repo] [--host claude-code,codex] [--memory-only] [--force]` | Onboarding idempotente del repo completo: DB + root, catálogo software→project→repo, index, seeds, guías, `.mcp.json`/hooks y hook post-merge. Escribe `.aitl/project.json` (la clave canónica). |
| `init agent [--out AGENTS.md] [--project aitl-js] [--mcp aitl-js] [-i] [--force]` | Solo la guía `AGENTS.md` (funciona sin Mongo). |
| `init claude [--out CLAUDE.md] [--project aitl-js] [--mcp aitl-js] [-i] [--force]` | Solo el inicializador `CLAUDE.md` para Claude Code (funciona sin Mongo). |

### Correr agentes

| Comando | Qué hace |
|---|---|
| `run <task> --project <p> [--model primary] [--bare] [--verify-cmd] [--loop-spec] [--max-iters] [--budget-tokens/--budget-ms] [--stall-threshold] [--max-verify-rounds] [--reflect] [--roles] [--ask [--ask-fallback deny]] [--mcp [path]] [--stream]` | El loop agéntico verificable (ADR-0062), persistido en Mongo. `--bare` = condición C0 de la tesis; el default completo = C2. |
| `chat [--project] [--model auto] [--ask] [--mcp/--no-mcp] [--no-markdown]` | REPL estilo Claude Code sobre el loop (stream, traza de tools, `/help`). |
| `run-host <task> --project <p> --host claude-code\|codex\|antigravity [--cwd --timeout --permission-mode --allowed-tools --no-record-prompt --no-spec-synthesis]` | Corre la tarea SOBRE un host externo, envuelto con contexto durable + telemetría; los permisos viajan explícitos en el argv. |
| `orchestrate <task> --project <p> [--model] [--max 4]` | Descompone la tarea, corre sub-agentes en paralelo y sintetiza. |
| `council <task> --project <p> --hosts <lista> [--judge] [--rounds 2] [--cwd --timeout --json]` | Plan-council: proponer → criticar anónimo con rúbrica → juez. Nada se ejecuta; hosts en solo-lectura. |
| `sdd <prompt> --project <p> [--model] [--repo] [--max-tasks 10]` | Fase D del SDD: spec → design doc → descomposición en tareas, como memoria enlazada. |

### Medición (condiciones de la tesis)

| Comando | Qué hace |
|---|---|
| `run-show <runId>` | Totales medibles del run: tokens, iteraciones, tool calls, denegaciones de gate, hydrate, `stop_reason`/`verified`. |
| `intervene <runId> --reason <texto> [--minutes 0]` | Registra una intervención humana sobre un run (métrica de supervisión). |

> No existe `aitl eval`: C0 = `aitl run --bare` vs C2 = `aitl run` (default). Compara con
> `aitl run-show <runId>`.

### Memoria y conocimiento

| Comando | Qué hace |
|---|---|
| `ingest --path <dir> --project <p> [--repo]` | Parse → clasifica → embebe → upserta memoria markdown. |
| `search <query> --project <p> [--collection memory\|messages\|decisions] [--limit 10]` | Búsqueda semántica `$vectorSearch` (cae a texto). |
| `synthesize --project <p> [--force] [--at <ref>] [--compact]` | Compresión rodante de memoria por categoría (map-reduce, sin truncados silenciosos); `--compact` archiva las fuentes absorbidas sin borrarlas. |
| `sync [--project] [--pull\|--push] [--dir .aitl] [--adr-dir docs/adr] [--include-reserved]` | Sync markdown bidireccional Mongo ⇄ `.aitl/{memory,skills,agents}` + `docs/adr` (por manifiesto; conflictos reportados, exit 2). |
| `adr-sync --project <p> [--dir docs/adr]` | Espeja ADRs formato Nygard de un directorio a la colección `decisions`. |
| `export --adapter <agents_md\|cursor\|copilot\|antigravity\|kiro\|trae\|markdown\|tasks> --project <p> [--root .]` | Proyecta los artefactos canónicos al formato nativo de una herramienta (incremental). |
| `hydrate [prompt] [--project aitl-js] [--component] [--no-vector] [--max-chars 4000]` | Imprime el preámbulo de contexto durable (memoria + ADRs + convenciones + repo map) para inyectar en un host externo (hook `UserPromptSubmit`). |
| `capture-session [--project aitl-js] [--transcript] [--session] [--cwd] [--component] [--source claude-code]` | Captura una sesión de host terminada en memoria durable + snapshot de contexto (hook `Stop`). |

### Historial durable

| Comando | Qué hace |
|---|---|
| `prompt add <texto> --project <p> [--title --source cli --tags]` | Registra un prompt en el historial durable. |
| `prompt list --project <p> [--source --tag --limit 50]` | Lista el historial (más nuevos primero). |
| `prompt search <query> --project <p> [--limit 10]` | Busca en el historial (`$text` con fallback regex). |
| `adr history <id> --project <p> [--diff] [--from --to]` | Historial de revisiones de un ADR (diff a nivel campo). |
| `adr deprecate <id> --project <p> --reason <texto> [--superseded-by] [--review-after]` | Depreca un ADR con motivo (append-only; fuera de hydrate, nunca borrado). |
| `memory history <slug> --project <p> [--diff] [--from --to]` | Historial de revisiones de una memoria. |

### Roles de ingeniería (H11)

| Comando | Qué hace |
|---|---|
| `role seed --project <p>` | Siembra el catálogo de roles (security, devops, qa, architect, devsecops). |
| `role list --project <p>` | Lista los roles. |
| `role rm <name> --project <p>` | Elimina un rol. |
| `role gate-check <path> --project <p> --role <name>` | Veto determinista de un rol modo gate sobre una ruta (sin modelo). |
| `review <target\|@archivo> --project <p> --roles <lista> [--model]` | Los roles revisan un target → DecisionBrief (asiste, no reemplaza). |

### Construcción y coordinación multi-agente

| Comando | Qué hace |
|---|---|
| `build skill <name> --project <p> [--desc --content --from <file> --tags]` | Construye y persiste UNA skill (scaffold si no das contenido). |
| `build agent <name> --project <p> [--desc --content --from --tags --host --model]` | Ídem para un agente (`--host model\|claude-code\|codex`). |
| `build seed --project <p>` | Registra las skills maestras (definition-builder, repo-indexer). |
| `coord claim <task_key> --project <p> [--scope --ttl <min>]` | Reclama una tarea (atómico; re-reclamar la propia la renueva). |
| `coord release <task_key> --project <p> [--outcome done\|abandoned]` | Libera tu claim activo (emite evento). |
| `coord list --project <p> [--all]` | Lista claims (activos por defecto; `--all` incluye historial). |
| `coord poll --project <p> [--since <iso>] [--quiet]` | Poll incremental de eventos de coordinación (cursor persistente; `--quiet` para hooks). |

---

## 3. Nivel REPO

El repo es la hoja del catálogo y el **sub-scope de datos**: varios comandos de project
aceptan `--repo` para etiquetar símbolos y memoria (`ingest --repo`, `sdd --repo`).

| Comando | Qué hace |
|---|---|
| `repo add <name> --project <p> [--software --remote --branch --path --desc --tags]` | Crea/actualiza un repo bajo un project. |
| `repo list [--project] [--software]` | Lista repos por project y/o software. |
| `repo get <name> --project <p>` | Muestra un repo. |
| `repo rm <name> --project <p>` | Elimina un repo del catálogo. |
| `index-repo --root <dir> --project <p> [--repo] [--memory <dir>] [--adr <dir>]` | Indexador maestro: repo map + ingesta de memoria + sync de ADRs en una pasada. |
| `repomap --project <p> [--root <dir>] [--repo] [--modules [--json]]` | Repo map tree-sitter + PageRank (top símbolos), o el mapa de módulos (`view|back|mixed|infra`) con `--modules`. |
| `module-brief <dir> --project <p> [--repo] [--json]` | Brief de un módulo: bloque del module-map + ADRs ACTIVOS con `components[]` que coinciden + memorias `component:<dir>`. |

```bash
aitl repo add AITL-Harness-JS --project aitl-js --path . --branch main
aitl index-repo --root . --project aitl-js --repo AITL-Harness-JS
aitl module-brief src/server --project aitl-js
```

---

## 4. Nivel BRANCH

Las ramas se clasifican por repo y alimentan el grafo de branches de la web UI.

| Comando | Qué hace |
|---|---|
| `branch sync --project <p> --repo <r> [--root .] [--remote <url>] [--reindex]` | Lee las ramas git del repo, las clasifica y las upserta; `--reindex` corre el indexador maestro si la head del trunk base avanzó. |
| `branch list [--project] [--repo] [--kind main\|master\|develop\|staging\|release\|hotfix\|feature\|other]` | Lista ramas clasificadas (más nuevas primero). |
| `branch rm <name> --project <p> --repo <r>` | Elimina una rama del catálogo. |

```bash
aitl branch sync --project aitl-js --repo AITL-Harness-JS --reindex
aitl branch list --project aitl-js --kind feature
```

---

## Flujo típico end-to-end

```bash
# 0. Infra
docker compose up -d && aitl init-db && aitl check-db

# 1-3. Onboarding: software + project + repo + índice + guías + hooks, en un comando
aitl init --project aitl-js --software tesis --repo AITL-Harness-JS --host claude-code

# 4. Ramas
aitl branch sync --project aitl-js --repo AITL-Harness-JS

# Trabajo diario
aitl run "arregla el bug X" --project aitl-js --verify-cmd "npm test" --stream   # C2
aitl run "arregla el bug X" --project aitl-js --bare                             # C0
aitl run-show <runId>
```
