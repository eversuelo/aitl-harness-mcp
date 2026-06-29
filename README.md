# AITL-Harness-JS

Port TypeScript de AITL-Harness: CLI global, servidor MCP, memoria durable en MongoDB,
modelos via OpenRouter, hosts de agente (Codex/Claude Code/Antigravity), repomap, ADR sync,
UI web de memoria y panel interactivo.

El binario publico es `aitl`.

## Cómo lo uso (flujo diario)

Este es el flujo mínimo de día a día: levantar el MCP, levantar la UI, y dejar que Claude
Code lea/escriba el estado durable en `aitl-js`.

```bash
# 1) (una sola vez) configura Mongo a nivel usuario — ver "Instalación global" abajo
aitl config set MONGODB_URI "mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/aitl?appName=<app>"
aitl config set MONGODB_DB aitl
aitl check-db          # valida la conexión
aitl init-db           # crea colecciones e índices (idempotente)

# 2) levanta el servidor MCP (lo consume Claude Code; transporte stdio por defecto)
aitl mcp               # déjalo corriendo; los logs van a stderr / AITL_MCP_LOG_FILE

# 3) levanta la UI de memoria + métricas (otra terminal)
aitl ui --project aitl-js
#   API  → http://localhost:4317/api
#   SPA  → http://localhost:5317   (tabs: Memory · Decisions · Prompts · Runs · Graph · Knowledge)
```

Con el MCP registrado en Claude Code (ver [Forzar que Claude Code use siempre el
MCP](#forzar-que-claude-code-use-siempre-el-mcp)), abre tu sesión de Claude Code en el
repo y pégale este contrato corto para que escriba en `aitl-js`:

```text
Usa el MCP aitl-js con project="aitl-js".
ANTES de cualquier decisión no trivial: search_memory + list_decisions.
DESPUÉS de decidir/aprender: record_decision (ADR) y/o write_memory; y record_prompt del prompt que guió el trabajo.
Si el MCP y tus supuestos chocan, gana el MCP (o explícita el conflicto).
```

Para medir una tarea ejecutada por Claude Code (tokens/costo/turnos), corre la tarea
*sobre* el host y revisa su telemetría:

```bash
aitl run-host "<tarea o spec>" --project aitl-js --host claude-code
aitl run-show <runId>     # tokens in/out/total, costo, iters, eventos, hidratación
```

Si el prompt es una **especificación** (SDD), el harness lo detecta solo, lo guarda en el
historial de prompts (tag `spec`) y escribe una **síntesis spec↔tarea** en memoria
(`spec-synthesis-<run>`) que une el spec, el resultado y las métricas. Todo aparece en la
pestaña **Runs** de la UI.

## Instalacion global

### Desde este checkout

```powershell
cd AITL-Harness-JS
npm ci
npm run build
npm install -g .
aitl --help
```

### Desde npm

El paquete queda preparado para publicarse como `aitl-mcp`:

```powershell
npm install -g aitl-mcp
aitl --help
```

Si el nombre `aitl-mcp` no estuviera disponible en npm, publica bajo un scope
(`@tu-scope/aitl-mcp`) y conserva el mismo binario `aitl`.

### Verificar instalacion

```powershell
aitl config path
aitl config show
aitl check-db
```

La instalacion global usa perfil de usuario en `~/.aitl/config.json`, no depende de
un `.env` local. Ver [ADR-0006](docs/adr/0006-user-level-config-profile.md).

## Configuracion de la cadena Mongo

La instalación global guarda un perfil de usuario en `~/.aitl/config.json` (override con
`AITL_HOME`), independiente de cualquier `.env` del repo (ver
[ADR-0006](docs/adr/0006-user-level-config-profile.md)). Ese perfil lo usan el CLI, los
**hooks** de Claude Code y, si quieres, también el servidor MCP. Precedencia:
`variables de entorno > perfil > defaults`.

**MongoDB Atlas (recomendado para la tesis).** Copia tu connection string del cluster
(Atlas → Connect → Drivers) y guárdalo en el perfil — **no** en git:

```bash
aitl config set MONGODB_URI "mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/aitl?appName=<app>"
aitl config set MONGODB_DB aitl
aitl config set EMBEDDING_PROVIDER local
aitl config set EMBEDDING_MODEL "Xenova/all-MiniLM-L6-v2"
aitl config set EMBEDDING_DIMS 384
```

Puedes definir un fallback local con `MONGODB_URI_FALLBACK` (Atlas por seedlist con caída
a local; ver ADR-0010). Si la contraseña tiene caracteres especiales (`@ : / ? # %`),
URL-encódeala (por ejemplo `*` → `%2A`).

**Mongo local** (p. ej. el docker compose del port Python):

```bash
aitl config set MONGODB_URI "mongodb://localhost:27018/?directConnection=true"
aitl config set MONGODB_DB aitl
```

Verifica e inicializa (idempotente: crea colecciones e índices, incl. el vectorial):

```bash
aitl config show   # config efectiva, con secretos enmascarados
aitl check-db
aitl init-db
```

> Seguridad: el perfil `~/.aitl/config.json` guarda secretos en claro en tu máquina. No lo
> subas a git. `aitl config show`/`export` enmascaran secretos por defecto (usa `--secrets`
> solo para transferir). Si pegaste la cadena con contraseña en un `.mcp.json`, rótala.

Para usar modelos via OpenRouter (unico provider de modelo; gateway compatible con OpenAI):

```powershell
aitl config set OPENROUTER_API_KEY "<openrouter-key>"
aitl config set OPENROUTER_MODEL "anthropic/claude-3.5-sonnet"
aitl run "resume el proyecto" --project demo --model openrouter
```

Los model ids de OpenRouter son namespaced, por ejemplo `anthropic/claude-3.5-sonnet`,
`google/gemini-2.0-flash-exp:free` o `openrouter/auto`.

Para correr el harness SOBRE un agente-host (en vez de un modelo crudo):

```powershell
aitl run-host "haz una tarea" --project demo --host claude-code
```

El harness envuelve al host con contexto durable y telemetria. Hosts: `claude-code`, `codex`, `antigravity`.

## Forzar que Claude Code use siempre el MCP

No se puede *obligar* al modelo a invocar una tool concreta a mitad de su razonamiento,
pero sí puedes apilar cuatro capas que, juntas, hacen que cada sesión lea y escriba el
estado durable. De la más débil (disponibilidad) a la más fuerte (determinista):

**1. Registrar y habilitar el server** (lo hace disponible). En el `.mcp.json` del repo:

```json
{
  "mcpServers": {
    "aitl-js": { "command": "aitl", "args": ["mcp"] }
  }
}
```

Y en `.claude/settings.local.json`, habilítalo para que Claude Code lo cargue sin
preguntar en cada arranque:

```json
{ "enableAllProjectMcpServers": true, "enabledMcpjsonServers": ["aitl-js"] }
```

**2. Auto-aprobar las tools del server** para que no te pida permiso cada vez (si no, la
fricción hace que el agente las evite). En `.claude/settings.local.json`:

```json
{ "permissions": { "allow": ["mcp__aitl-js"] } }
```

`mcp__aitl-js` permite todas las tools del server; para acotar usa
`mcp__aitl-js__search_memory`, `mcp__aitl-js__write_memory`, etc.

**3. Contrato de operación que el modelo lee.** Claude Code carga `CLAUDE.md`
automáticamente; genera además un `AGENTS.md` que ordena consultar el MCP **antes** de cada
decisión y persistir **después**:

```bash
aitl init agent --project aitl-js --mcp aitl-js --out AGENTS.md
```

**4. Hooks — la única capa determinista.** Los hooks de Claude Code corren comandos shell
pase lo que pase, sin depender de que el modelo "se acuerde". Añádelos a
`.claude/settings.local.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "aitl hydrate --project aitl-js --no-vector" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "aitl capture-session --project aitl-js" } ] }
    ]
  }
}
```

- `UserPromptSubmit → aitl hydrate`: inyecta el preámbulo durable (memoria + ADRs +
  convenciones + repo map) en **cada** prompt. El stdout del hook se agrega al contexto.
- `Stop → aitl capture-session`: al terminar la sesión, resume el transcript en **un** doc
  de memoria + un snapshot, auto-etiquetado por los componentes (directorios) que editaste.

> Los hooks ejecutan el binario `aitl` **fuera** del proceso MCP, así que necesitan
> `MONGODB_URI`/`MONGODB_DB` en `~/.aitl/config.json` (por eso el perfil global de
> ADR-0006). Sin instalación global, reemplaza `aitl` por
> `npm --prefix /ruta/al/repo run aitl --` en los comandos del hook. Ver ADR-0022/ADR-0023.

En resumen: capas 1–3 hacen que el MCP esté disponible, sin fricción y "ordenado"; la capa
4 es la que realmente **garantiza** lectura (hydrate) y escritura (capture) en cada turno.

## Comandos principales

| Comando | Uso |
|---|---|
| `aitl` / `aitl -i` | Abre el panel interactivo. |
| `aitl config show` | Muestra config efectiva con secretos enmascarados. |
| `aitl check-db` | Valida conexion a Mongo. |
| `aitl init-db` | Crea colecciones e indices. |
| `aitl ingest --path docs --project demo` | Ingiere memoria markdown. |
| `aitl search "query" --project demo` | Busca en memoria durable. |
| `aitl run "task" --project demo --model openrouter` | Ejecuta el loop agente (modelos via OpenRouter). |
| `aitl run-host "task" --project demo --host claude-code` | Corre la tarea SOBRE un agente-host; mide tokens/costo/turnos (Claude Code vía JSON) y auto-sintetiza specs. |
| `aitl orchestrate "task" --project demo` | Descompone la tarea y corre sub-agentes en paralelo. |
| `aitl repomap --root . --project demo` | Construye mapa de repo. |
| `aitl adr-sync --dir docs/adr --project demo` | Espeja ADRs en Mongo. |
| `aitl export --adapter cursor --project demo` | Proyecta canon a herramientas externas. |
| `aitl mcp` | Arranca servidor MCP stdio. |
| `aitl ui --project demo` | Arranca API + SPA (Memory · Decisions · Prompts · **Runs/métricas** · Graph · Knowledge map). |

### Roles de ingeniería (H11) y medición (ciclo 0024–0033)

| Comando | Uso |
|---|---|
| `aitl role seed --project demo` | Crea el catálogo de roles (security, devops, qa, architect, devsecops). |
| `aitl role list --project demo` | Lista roles (modo review/pair/gate + severidad). |
| `aitl role gate-check .env --project demo --role security` | Veto determinista de un gate-role (sin modelo). |
| `aitl review @diff.txt --project demo --roles security,architect` | Roles revisan un target → **DecisionBrief** que asiste la decisión. |
| `aitl run "task" --project demo --roles security,qa` | Acopla roles al loop (gate veta; review/pair critican al cierre). |
| `aitl run "task" --project demo --bare` | Condición **C0** (sin memoria/skills/gates). |
| `aitl run "task" --project demo --verify-cmd "npm test"` | Quality gate: el loop no cierra hasta verde. |
| `aitl run-show <runId>` | Telemetría del run: tokens, iters, tool_calls, hydrate, intervenciones, roles; en runs de host además costo/turnos (`host_meta`) y `spec`. |
| `aitl intervene <runId> --reason "…" --minutes 5` | Registra supervisión humana (Tabla 4.3 #6). |
| `aitl software/repo/branch …` | Catálogo software→projects→repos + grafo de ramas. |
| `aitl build {skill,agent,seed}` · `aitl index-repo …` | Constructora de definiciones e indexador maestro. |
| `aitl adr history <id> --diff` · `aitl memory history <slug> --diff` | Historial versionado con diff. |

## MCP aitl-js

`aitl mcp` expone memoria durable, ADRs, repomap, graphify y un historial de prompts.
Tools principales:

| Tool | Proposito |
|---|---|
| `record_prompt` | Guarda un prompt con `project`, `title`, `source`, `tags` y metadata opcional. |
| `list_prompts` | Lista historial reciente por proyecto. |
| `search_prompts` | Busca prompts guardados por texto. |
| `search_memory` / `write_memory` | Lee y escribe memoria durable. |
| `list_decisions` / `record_decision` | Lee y registra ADRs. |
| `get_repomap` / `graphify` | Expone mapa de repo y grafo del estado durable. |

### Tutorial rapido: usar el MCP del harness

El flujo recomendado es:

1. Configurar MongoDB.
2. Crear colecciones e indices.
3. Registrar el servidor MCP `aitl-js` en tu cliente/agente.
4. Hacer que el agente consulte y escriba memoria durable antes/despues de decisiones.

#### 1. Configura la base durable

Si usas instalacion global, guarda la configuracion en `~/.aitl/config.json`:

```powershell
aitl config set MONGODB_URI "mongodb://localhost:27018/?directConnection=true"
aitl config set MONGODB_DB aitl
aitl config set EMBEDDING_PROVIDER local
aitl config set EMBEDDING_MODEL "Xenova/all-MiniLM-L6-v2"
aitl config set EMBEDDING_DIMS 384
```

Para Atlas, usa tu connection string de Atlas en `MONGODB_URI`. No lo guardes en git.

Valida conexion y prepara indices:

```powershell
aitl check-db
aitl init-db
```

#### 2. Prueba el servidor MCP manualmente

Para una instalacion global:

```powershell
aitl mcp
```

Para desarrollo desde este checkout:

```powershell
pnpm build
node dist/src/mcpserver/server.js
```

El transporte por defecto es `stdio`, que es lo que usan la mayoria de clientes MCP.
Los logs diagnosticos salen por `stderr`, para no contaminar el protocolo MCP.

#### 3. Registra `aitl-js` en tu cliente MCP

Si el paquete esta instalado globalmente y ya configuraste `aitl config`, la forma mas
portable es:

```json
{
  "mcpServers": {
    "aitl-js": {
      "command": "aitl",
      "args": ["mcp"]
    }
  }
}
```

Si prefieres no depender del perfil global, puedes pasar variables de entorno al servidor:

```json
{
  "mcpServers": {
    "aitl-js": {
      "command": "aitl",
      "args": ["mcp"],
      "env": {
        "MONGODB_URI": "mongodb://USER:PASS@HOSTS/aitl?ssl=true&authSource=admin&replicaSet=...",
        "MONGODB_DB": "aitl",
        "EMBEDDING_PROVIDER": "local",
        "EMBEDDING_MODEL": "Xenova/all-MiniLM-L6-v2",
        "EMBEDDING_DIMS": "384",
        "AITL_MCP_LOG_FILE": "logs/aitl-js-mcp.log",
        "AITL_MCP_LOG_RESULT_CHARS": "8000"
      }
    }
  }
}
```

En desarrollo local, tambien puedes apuntar directo al build:

```json
{
  "mcpServers": {
    "aitl-js": {
      "command": "node",
      "args": ["C:/ruta/a/AITL-Harness-JS/dist/src/mcpserver/server.js"],
      "env": {
        "MONGODB_URI": "mongodb://localhost:27018/?directConnection=true",
        "MONGODB_DB": "aitl"
      }
    }
  }
}
```

La ubicacion exacta del archivo de configuracion depende del cliente MCP. En clientes que
leen configuracion por workspace, coloca el bloque anterior en el `.mcp.json` del repo o
en el archivo equivalente que use tu agente.

El nombre dentro de `mcpServers` es solo un alias del cliente. Puede llamarse `aitl-js`,
`aitl-mcp`, `memory`, o como prefieras. Lo importante es usar el mismo nombre cuando
instruyas al agente o generes `AGENTS.md`.

Ejemplo si en otra computadora lo registraste como `aitl-mcp`:

```json
{
  "mcpServers": {
    "aitl-mcp": {
      "command": "aitl",
      "args": ["mcp"]
    }
  }
}
```

#### 4. Primer uso desde un agente

Una vez conectado, pide al agente que use el alias del servidor MCP con un proyecto fijo:

```text
Usa el MCP aitl-js con project="demo".
Antes de proponer cambios, consulta search_memory y list_decisions.
Si aprendes una decision o convencion nueva, guardala con write_memory o record_decision.
```

Si el alias del server en esa maquina es `aitl-mcp`, la instruccion debe coincidir:

```text
Usa el MCP aitl-mcp con project="demo".
Antes de proponer cambios, consulta search_memory y list_decisions.
Si aprendes una decision o convencion nueva, guardala con write_memory o record_decision.
```

Ejemplos de operaciones utiles:

| Objetivo | Tool MCP |
|---|---|
| Recordar contexto previo | `search_memory` con `project` y `query`. |
| Guardar una nota durable | `write_memory` con `project`, `slug`, `type`, `description`, `body`. |
| Ver decisiones aceptadas | `list_decisions`. |
| Registrar una decision | `record_decision` con Context / Decision / Consequences. |
| Guardar el prompt de trabajo | `record_prompt`. |
| Guardar un snapshot de conversacion/contexto | `save_mcp_context`. |
| Explorar estructura de codigo | `get_repomap` o `graphify`. |
| Guardar instrucciones reutilizables | `write_agent` o `write_skill`. |

### Como anadir el Harness MCP a agentes

Hay dos capas: conectar el servidor MCP al cliente y dejar instrucciones durables para
que cualquier agente lo use correctamente.

#### A. Conecta el servidor MCP

Registra un server en el cliente MCP del agente usando uno de estos formatos. El nombre
`aitl-js` es un alias; puedes cambiarlo por `aitl-mcp` si asi se llama en esa compu:

```json
{
  "mcpServers": {
    "aitl-js": {
      "command": "aitl",
      "args": ["mcp"]
    }
  }
}
```

El mismo ejemplo con alias `aitl-mcp`:

```json
{
  "mcpServers": {
    "aitl-mcp": {
      "command": "aitl",
      "args": ["mcp"]
    }
  }
}
```

o, si trabajas desde el checkout sin instalacion global:

```json
{
  "mcpServers": {
    "aitl-js": {
      "command": "node",
      "args": ["./AITL-Harness-JS/dist/src/mcpserver/server.js"]
    }
  }
}
```

Usa rutas absolutas si el cliente MCP no arranca desde la raiz del workspace.

#### B. Genera un `AGENTS.md` para obligar al agente a consultar el MCP

Desde el repo donde trabajara el agente:

```powershell
aitl init agent --project demo --mcp aitl-js --out AGENTS.md
```

Si el cliente MCP lo conoce como `aitl-mcp`, genera el contrato con ese nombre:

```powershell
aitl init agent --project demo --mcp aitl-mcp --out AGENTS.md
```

Ese archivo instruye al agente a:

- consultar `search_memory`, `list_decisions` y `get_repomap` antes de decisiones no triviales;
- persistir aprendizajes con `write_memory`;
- registrar decisiones con `record_decision`;
- mantener el scope `project` consistente.

Tambien puedes hacerlo interactivo:

```powershell
aitl init agent --interactive
```

#### C. Guarda agentes y skills dentro del MCP

El MCP tambien tiene colecciones durables para definiciones reutilizables:

- `write_agent`, `get_agent`, `list_agents`, `search_agents`, `delete_agent`
- `write_skill`, `get_skill`, `list_skills`, `search_skills`, `delete_skill`

Ejemplo de instruccion para un cliente MCP:

```text
En el MCP aitl-js, guarda un skill para project="demo" llamado "code-review"
que indique revisar diffs buscando bugs, regresiones y pruebas faltantes.
```

Durante `aitl run`, el router de skills busca skills relevantes del proyecto y los inyecta
en el prompt del agente de forma best-effort.

#### D. Checklist de verificacion

```powershell
aitl check-db
aitl init-db
aitl mcp
```

En el cliente MCP, confirma que aparecen tools como `search_memory`, `write_memory`,
`list_decisions`, `record_prompt`, `write_agent` y `write_skill`.

Para ver lo que el MCP va guardando:

```powershell
aitl ui --project demo
aitl prompt list --project demo
aitl search "decision" --project demo
```

### MCP por HTTP

Para clientes remotos o tuneles, `aitl mcp` tambien puede usar Streamable HTTP:

```powershell
aitl mcp --http --host 127.0.0.1 --port 8000 --path /mcp --token "<token>"
```

Usa `--token` si expones el servidor fuera de localhost. Para internet publica, ponlo
detras de TLS/proxy y evita exponer MongoDB directamente.

Nota importante: cuando configuras MCP por `stdio`, el cliente/agente ejecuta el
`command` en su misma maquina. Si el harness esta instalado en otra computadora y quieres
usarlo desde un agente remoto, arranca el MCP con `--http` en la computadora que hospeda
AITL y configura el cliente remoto con la URL que soporte tu cliente MCP. El alias puede
seguir siendo `aitl-mcp`; solo cambia el transporte.

## Mapa de contenido

| Ruta | Contenido |
|---|---|
| [src/README.md](src/README.md) | Mapa de modulos TypeScript. |
| [docs/README.md](docs/README.md) | Indice de documentacion, planes, sesiones y ADRs. |
| [docs/adr/README.md](docs/adr/README.md) | Bitacora de decisiones. |
| [web/README.md](web/README.md) | UI web de administracion de memoria. |
| [scripts/README.md](scripts/README.md) | Scripts directos de DB. |
| [package.json](package.json) | Nombre npm, binario y scripts. |
| [tsconfig.json](tsconfig.json) | Configuracion TypeScript. |

## Arquitectura resumida

El loop vive en [src/orchestration/graph.ts](src/orchestration/graph.ts) y habla solo con
el puerto [Provider](src/providers/base.ts). La memoria durable se centraliza en
[MemoryStore](src/memory/store.ts). Mongo se aisla en [src/db/](src/db/). Las tools se
registran por [src/tools/](src/tools/) y se exponen al modelo como esquemas
provider-agnostic.

Las decisiones arquitectonicas no se esconden en comentarios: estan en
[docs/adr/](docs/adr/) y se pueden espejar a Mongo con `aitl adr-sync`.

## Desarrollo local

```powershell
npm ci
npm run build
npm run typecheck
npm test
```

Para desarrollo sin instalacion global:

```powershell
npm run aitl -- --help
npm run mcp
npm run ui
```

## Publicacion npm

Antes de publicar:

```powershell
npm ci
npm run build
npm test
npm pack --dry-run
```

Luego:

```powershell
npm publish
```

El paquete debe incluir `dist/`, `package.json` y docs utiles. No publiques `.env`,
`logs/` ni `node_modules/`.
