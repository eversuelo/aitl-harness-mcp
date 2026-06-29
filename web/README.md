# Memory Admin Web UI

SPA React para administrar la memoria durable del harness y ver la **telemetría medida**
de cada run.

Decision relacionada: [ADR-0007](../docs/adr/0007-memory-admin-web-ui.md).

## Pestañas

| Pestaña | Contenido |
|---|---|
| Memory | CRUD + búsqueda semántica de memorias durables. |
| Decisions | ADRs (Context / Decision / Consequences). |
| Prompts | Historial de prompts (incl. los `spec` capturados por `run-host`). |
| **Runs** | Métricas por run: tokens (in/out/total), costo, iters/turnos, tool_calls, gate_denials, duración, desglose de caché, roles, eventos y supervisión humana. Cabecera con rollup agregado (Σ tokens, Σ costo). |
| Graph | Grafo force-directed de memoria/símbolos. |
| Knowledge Map | Grafo multi-entidad software→repos→branches→memoria/decisiones. |

## Ejecutar

Desde el paquete JS:

```powershell
npm run ui
```

O desde instalacion global:

```powershell
aitl ui --project demo
```

`aitl ui` arranca dos procesos:

- API HTTP en `http://localhost:4317/api`
- Vite dev server en `http://localhost:5317`

Puedes cambiar puertos:

```powershell
aitl ui --api-port 4320 --web-port 5320
```

## Archivos

| Ruta | Rol |
|---|---|
| [src/App.tsx](src/App.tsx) | Shell principal + todas las vistas (Memory/Decisions/Prompts/Runs/Graph/Knowledge). |
| [src/api.ts](src/api.ts) | Cliente HTTP tipado contra `/api` (incl. `runs`/`run`). |
| [src/components/](src/components/) | `Markdown` + primitivas `ui/` (shadcn/Tailwind). |
| [src/index.css](src/index.css) | Estilos base + tema. |
| [vite.config.ts](vite.config.ts) | Proxy `/api` hacia el launcher. |
| [index.html](index.html) | Entrada HTML. |

## Backend

El backend vive en [../src/server/api.ts](../src/server/api.ts) y reusa
[MemoryStore](../src/memory/store.ts). Las escrituras de memoria siguen el mismo camino que
`write_memory`: clasificar, embeddear y upsert. La pestaña Runs consume `GET /api/runs` y
`GET /api/runs/:id` (proyección de la colección `runs` + conteo de eventos).

## Limitaciones

La UI corre como dev server Vite. La ADR deja pendiente una version empacada en un solo
puerto para una distribucion global mas cerrada.
