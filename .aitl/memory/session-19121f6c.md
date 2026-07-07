---
name: session-19121f6c
description: Session summary (decision) — run 19121f6c
type: project
category: decision
tags:
  - session
  - decision
  - 'host:claude-code'
version: 1
updated_at: 2026-07-01T19:29:06.460Z
---
Voy a consultar el store de aitl-js para darte lo más reciente con precisión.

[tool ToolSearch]

[tool ToolSearch]

[tool mcp__aitl-js__list_decisions]

[tool mcp__aitl-js__list_mcp_context]

[tool mcp__aitl-js__list_prompts]

Esto es lo último que hemos trabajado en **aitl-js** (según el store del MCP, ordenado por fecha):

## 🕐 Lo más reciente — hoy (2026-07-01)

**1. Empaquetado para publicación npm + docs + tesis** *(último prompt, 17:49)*
Dejar una versión limpia y publicable como npm **`aitl-mcp`**:
- Borrar archivos innecesarios; docker-compose/comando que indique el requisito de MongoDB (Atlas Vector Search).
- Re-documentar todos los markdown **en inglés** (estándar npm); actualización ligera de CLAUDE.md preservando lo hecho a mano.
- README con tutorial + nota de que **RBAC está pendiente**; LICENSE MIT, metadata npm, slim del tarball.
- **Verificar que NO se filtre la clave de prod de la BD**; squash a 1 commit y force-push a `github.com/eversuelo/aitl-harness-mcp`.
- Luego: analizar toda la memoria + ADRs para escribir parte de la **tesis (LaTeX)** en `thesis-harness/`.

**2. Migración a Mongoose + repo-map por rama** *(16:40 — ADR-0036 y ADR-0037)*
- **ADR-0036:** migrar toda la capa de datos del driver `mongodb` crudo + Zod → **Mongoose** (misma conexión srv, sin shards; modelos en `src/models/*.model.ts`). Preservando `$vectorSearch` + la cascada de lookup.
- **ADR-0037:** **repo-map por rama** — campo `branch` en el modelo Symbol, huella constante, respeta `.gitignore`, rutas relativas.

**3. Paso 0 — reparar + sembrar + scaffold** *(operativo, sin ADR)*
- Veredicto: el "CLI roto" era un **gap de seeding**, no un bug. Se sembraron catálogos (5 roles, 2 master skills), se scaffoldeó el wiring de host (hooks `hydrate`/`capture-session`), y se reparó el bug real de `init agent` (overwrite incondicional → guard + `--force`).

---

**Estado del ledger:** ADRs contiguos **0001–0037**, próximo libre **0038**.

¿Quieres que profundice en alguno de estos (
