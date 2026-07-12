---
name: workspace-ui-jerarquia-0073
description: >-
  ADR-0073 implementado: pestaña Workspace (árbol software→project→repo→branch +
  actividad MCP), ScopeSelector en cascada en el header (software acota el
  Workspace, repo/branch hacen deep-link), kindColors.ts compartido, layout
  responsivo, aitl tree, aitl ui --static y despliegue Docker cloud con túnel
  opcional.
type: project
category: reference
tags:
  - session-2026-07-11
  - adr-0073
  - ui
  - workspace
  - docker
  - cloud
  - 'component:web/src'
  - 'component:src/catalog'
  - 'component:src/server'
version: 1
updated_at: 2026-07-12T00:20:21.076Z
branch: feat/harness-v2
commit_sha: db899ce2e2c5c8a82cd59d5cf7404c66a522b3fb
---
Sesión 2026-07-11/12 (rama feat/harness-v2), ADR-0073. Detalle operativo que NO está en el ADR:

**Web (web/src/):**
- WorkspaceView.tsx: la pestaña es el tab INICIAL. Tree state = Set de ids `sw:<name>` / `pj:<project>` / `rp:<project>/<repo>` / `br:<p>/<r>/<name>`; al cargar auto-expande la cadena del project activo. El filtro de texto expande todo (`|| !!q`). ProjectDetail hace Promise.all de api.{list,decisions,runs,contexts} con .catch(()=>[]) por endpoint (un fallo no tumba el panel). mergeActivity ordena por fecha desc y corta a 12.
- ScopeSelector.tsx: totalmente CONTROLADO desde App (estados `software` ("" = todos) y `focus {repo?, branch?}`). Elegir software cuyo set no incluye el project activo salta al primer project del software. onFocusChange con repo → App cambia a tab workspace (deep-link). Sentinelas Radix: `__all__`/`__none__` (SelectItem no admite value="").
- kindColors.ts: NODE_FILL/EDGE_STROKE movidos de App.tsx + BRANCH_KIND_BADGE/BRANCH_ENV_BADGE (clases tailwind por kind/env de rama).
- Responsivo: TwoPane = `grid-cols-1 md:grid-cols-[minmax(320px,38%)_1fr]`, lista `max-h-[45vh]` en móvil; TabsList `h-auto flex-wrap`.

**CLI:** `aitl tree` (src/catalog/tree.ts puro + 6 tests). ANSI escritos como `` explícito (un ESC literal en el fuente se corrompe fácil). trunks primero via KIND_ORDER.

**Estático/Docker:**
- staticFiles.ts: resolveStaticFile(root, pathname) puro → traversal (incl. %2e%2e) cae al fallback index.html, nunca al FS; /assets/* = cache immutable (Vite fingerprintea). resolveWebDist() prueba ../../web/dist (src) y ../../../web/dist (dist compilado) porque web/ no se copia a dist/.
- createApiServer: campo opcional ApiDeps.staticDir; GET/HEAD no-/api → stream del archivo. ui.ts: --static explícito, o fallback automático si opts.web && !resolveViteBin() && hay build (caso npm i -g sin devDeps).
- GOTCHA Tailwind: `vite build` DEBE correr con cwd=web (los globs `content` son relativos al cwd, no al config) → script `npm run build:web` = `cd web && vite build`. Desde la raíz falla con «The border-border class does not exist».
- Smoke E2E verificado vivo en :4390 (health, index, fallback SPA 200 html, asset js immutable, traversal→index, /api/softwares y /api/branches en el mismo puerto).
- docker-compose.cloud.yml: perfil `tunnel` = cloudflared quick tunnel (`--url http://aitl:4317`), URL pública en `docker compose logs tunnel | grep trycloudflare`. Sin señal de compartir: solo host:4317.

**Decisión de arquitectura discutida:** NO separar el server (pregunta del usuario). El monolito multi-entrypoint comparte modelos/RBAC/conexión; el corte natural futuro sería createApiServer + web/dist si la UI necesitara escalado propio. Relacionado: [[branch-graph-adr-0031]], [[siembra-skill-router-2026-07-11]].
