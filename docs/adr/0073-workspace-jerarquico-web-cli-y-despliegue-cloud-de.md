# ADR-0073 — Workspace jerárquico (web + CLI) y despliegue cloud de una sola URL (--static + Docker)

- **Status:** accepted
- **Date:** 2026-07-12
- **Components:** web/src, src/catalog, src/server, src/cli.ts, Dockerfile, docker-compose.cloud.yml

## Context

La jerarquía software → project → repo → branch (ADR-0028/0031) solo era visible como grafo de fuerza (Knowledge Map), poco intuitivo para navegar el trabajo del MCP; el header de la web solo tenía un select plano de project; la UI no era responsiva (tabs desbordaban en pantallas chicas). Además `aitl ui` dependía del dev server de Vite incluso en producción: no había forma de desplegar el harness en un VPS/cloud con una URL compartible, y el docker-compose existente solo levantaba Mongo. El usuario pidió: (a) visualizar mejor la jerarquía y el trabajo del MCP, (b) un selector bonito y dinámico Software/Project/Repo/Branch en el header que acote el Workspace, (c) aplicar el mismo principio al CLI, (d) docker-compose para cloud con enlace compartible, evaluando si conviene separar el server.

## Decision

Cuatro piezas aditivas, sin separar el server (se mantiene el monolito multi-entrypoint: CLI/MCP/UI comparten modelos, RBAC y conexión Mongo; separar duplicaría auth y versionado sin necesidad hasta que exista escalado independiente):
1) Web UI — pestaña «Workspace» (web/src/components/WorkspaceView.tsx, tab inicial): árbol expandible software→project→repo→branch construido de /api/{softwares,repos,branches,projects}; grupo sintético «sin software» para projects huérfanos; panel de detalle por nodo con stat tiles (memorias/ADRs/runs/contextos) y feed «Actividad reciente del MCP» (mezcla ordenada de mcp_context + runs + decisions); ramas con badges por kind/environment y candado en protegidas. Selector jerárquico en el header (ScopeSelector.tsx): cuatro selects en cascada con puntos de color por kind; el software elegido ACOTA el Workspace, project sigue siendo el scope global, y elegir repo/branch hace deep-link (expande y selecciona el nodo en Workspace). Colores unificados en web/src/lib/kindColors.ts (compartidos con Graph/Knowledge Map). Layout responsivo: header con wrap, TabsList multi-línea, TwoPane apilado bajo md.
2) CLI — `aitl tree [--project] [--software] [--json] [--no-color]`: builder/render puros en src/catalog/tree.ts (buildCatalogTree agrupa con huérfanos; renderCatalogTree dibuja box-drawing con ANSI opcional, trunks primero), 6 tests.
3) Producción de una URL — `aitl ui --static`: el API server sirve la SPA compilada (web/dist) en el mismo puerto vía src/server/staticFiles.ts (resolveStaticFile puro: guard de traversal → fallback SPA, mime map, cache immutable para /assets fingerprinteados; resolveWebDist prueba ambos layouts src/ y dist/); ApiDeps.staticDir opcional en createApiServer; fallback automático a estático cuando Vite no está instalado pero existe build (npm -g). Scripts npm build:web / typecheck:web (vite build DEBE correr con cwd=web: los globs content de Tailwind son relativos al cwd).
4) Cloud — Dockerfile multi-stage (build TS+SPA → runtime slim con --omit=dev, CMD `aitl ui --static --no-web --watch-restart`, EXPOSE 4317) y docker-compose.cloud.yml: servicios mongodb (mongodb-atlas-local con healthcheck) + aitl (una URL host:4317; MONGODB_URI overrideable para Atlas real; AITL_WEB_ALLOW_SIGNUP=false por defecto) + perfil opcional `tunnel` (cloudflared quick tunnel → enlace público https://….trycloudflare.com sin cuenta, URL en logs).

## Consequences

- La jerarquía y el trabajo del MCP son navegables en dos superficies coherentes (web Workspace + aitl tree) con el mismo modelo mental y colores.
- Un contenedor = una URL compartible; el asistente de setup sigue siendo loopback-only, así que en Docker el root sale del bootstrap (log) o de `aitl user create`; signup apagado por defecto al exponer el enlace.
- El server NO se separa: puntos de reversa documentados — si algún día la UI necesita escalado propio, el corte natural es createApiServer (ya inyectable) + web/dist.
- resolveStaticFile nunca sirve fuera del root (traversal → index.html); rutas SPA desconocidas devuelven 200 index.html (client-side routing).
- Verificado: typecheck backend+web, 449 tests (6 nuevos de tree + 4 de staticFiles), vite build, smoke E2E vivo (health, index, fallback SPA, asset immutable, guard de traversal, /api/softwares y /api/branches por el mismo puerto).
