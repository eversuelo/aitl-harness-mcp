# AITL-Harness-JS

Port TypeScript de AITL-Harness: CLI global, servidor MCP, memoria durable en MongoDB,
providers LLM, repomap, ADR sync, UI web de memoria y panel interactivo.

El binario publico es `aitl`.

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

El paquete queda preparado para publicarse como `aitl-js`:

```powershell
npm install -g aitl-js
aitl --help
```

Si el nombre `aitl-js` no estuviera disponible en npm, publica bajo un scope
(`@tu-scope/aitl-js`) y conserva el mismo binario `aitl`.

### Verificar instalacion

```powershell
aitl config path
aitl config show
aitl check-db
```

La instalacion global usa perfil de usuario en `~/.aitl/config.json`, no depende de
un `.env` local. Ver [ADR-0006](docs/adr/0006-user-level-config-profile.md).

## Configuracion minima

Para Mongo local compatible con el docker compose del port Python:

```powershell
aitl config set MONGODB_URI "mongodb://localhost:27018/?directConnection=true"
aitl config set MONGODB_DB aitl
```

Para usar Google free tier:

```powershell
aitl config set GEMINI_API_KEY "<google-ai-studio-key>"
aitl run "resume el proyecto" --project demo --model google-free
```

Mas detalle: [docs/GOOGLE-FREE.md](docs/GOOGLE-FREE.md).

Para usar otro provider:

```powershell
aitl config set OPENAI_API_KEY "<key>"
aitl config set MODEL_SECONDARY openai
aitl run "haz una tarea" --project demo --model secondary
```

## Comandos principales

| Comando | Uso |
|---|---|
| `aitl` / `aitl -i` | Abre el panel interactivo. |
| `aitl config show` | Muestra config efectiva con secretos enmascarados. |
| `aitl check-db` | Valida conexion a Mongo. |
| `aitl init-db` | Crea colecciones e indices. |
| `aitl ingest --path docs --project demo` | Ingiere memoria markdown. |
| `aitl search "query" --project demo` | Busca en memoria durable. |
| `aitl run "task" --project demo --model google-free` | Ejecuta el loop agente. |
| `aitl repomap --root . --project demo` | Construye mapa de repo. |
| `aitl adr-sync --dir docs/adr --project demo` | Espeja ADRs en Mongo. |
| `aitl export --adapter cursor --project demo` | Proyecta canon a herramientas externas. |
| `aitl mcp` | Arranca servidor MCP stdio. |
| `aitl ui --project demo` | Arranca API + SPA de memoria. |

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
