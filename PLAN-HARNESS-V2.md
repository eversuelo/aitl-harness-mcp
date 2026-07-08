# Plan harness-v2 — espejo local del estado de sesión

> Corte: 2026-07-07 — **plan P0–P11 COMPLETO** (sesión cerrada) + ciclos post-sesión
> **ADR-0058** (permisos explícitos en el argv de los hosts) y **ADR-0059** (compresión
> rodante del knowledge en `synthesize`) cerrados. Fuente autoritativa: memoria MCP
> `aitl-js`, slug `session-harness-v2-plan-2026-07-06` (v10, historial vía
> `list_memory_versions`). To Do vivo: `thesis-harnesss/To Do.md`. Rama del harness:
> `feat/harness-v2` (merge a main pendiente de decisión del usuario).
> Ledger de ADRs: contiguo **0001–0059**, next free **0060** (leer next-free con
> `list_decisions` antes de registrar; nunca fijar el número en docs).
> Lo de abajo se conserva como registro histórico del plan.

## Decisiones confirmadas por el usuario
- Alcance completo por fases: fixes → features F1–F9 → limpieza → tesis al final.
- Auth web: login contra `users` (pbkdf2) → token **opaco** en colección `sessions` con TTL.
- TTL de ADRs: **suave** (`review_after`; se excluye de hydrate al vencer; nunca se borra).
- buildGraph/LangGraph: borrar. Sync markdown: ADRs→`docs/adr/`, resto→`.aitl/`.
- view/back: heurística extensión+ruta con override `.aitl/modules.json`.
- Council: implementar `adr/ADR-0003-plan-council-v2.tex` de la tesis tal cual.
- Coordinación v1: polling (sin change streams/HMAC).

## Cerrado (con commits)

### Harness (`AITL-Harness-JS`, rama feat/harness-v2)
- **P1 — Auth web (ADR-0046)** `cd76417`+`9c2720f`: colección `sessions` (solo sha256,
  índice TTL), `POST /api/auth/login|logout`, cascada sesión→AITL_WEB_TOKENS→anónimo,
  split 401 `login_required`/403, `delegated:true` para web autenticado (mismo modelo
  que guardTool), CORS allowlist `AITL_WEB_ORIGINS`, cliente web con Authorization +
  LoginDialog. verify 118/118. E2E vivo contra Atlas OK. Usuario de prueba `e2e-admin`
  (rol admin) — **borrar/rotar tras el piloto**.
- **P2 — Infra (ADRs 0047–0048)** `ba603ce`(usuario)+`d0e34e1`+`6d9c756`: LangGraph
  eliminado (runAgent loop único, resume desde transcript durable; un solo driver
  mongodb@7 dedupe); conexión única con Mongoose dueño (`db/client.ts` = compat,
  `getDb()` ya NO autoconecta); 15 factories `makeX()` async con `await doc.validate()`
  (~35 call sites); `util/quiet.ts` borrado; `aitl eval` retirado (C0=`run --bare`,
  C2=default, documentado); `AITL_MCP_TOKEN` en `.env.example`. Proceso termina solo.
- `pnpm-lock.yaml` estaba sucio desde antes de la sesión: **no tocar / no commitear**.

### Tesis (`thesis-harnesss`, master)
- `0634583` limpieza: Agent.md→AGENTS.md, artefactos LaTeX untrack, To Do/Notes viejos fuera.
- `9dacf3d` renumeración H1–H11 (c3, c5, appendix-rutas, ADR-0001/0002/0003).
  Mapa viejo→nuevo: verificación H4→H5 · sesiones largas H5→H4 · continuidad H2→H3 ·
  portabilidad/agnosticismo H3→H9 (o H2,H9) · supervisión H7→H10.
- `f7481c2` cap. 2: subsección + `tab:cap2-frameworks` (LangGraph/AutoGen/CrewAI/
  OpenAI Agents SDK/Aider/OpenHands) + 5 bib nuevas + 3 diferenciadores de AITL.
- `e7b4ac3` bitácora IMPL-0038–0046 + sección `sec:impl-vivo`; `392222a` añade
  IMPL-0047/0048 («cuarenta y ocho entradas»).
- `b9fb1d6`+`77e2436`+sig. — `To Do.md` vivo en la raíz (tesis/harness/medición, P3.5 añadida).

## En vuelo → PAUSADO (2026-07-06, por el usuario)
- **P3** (detenido con la implementación COMPLETA y verify-green — `wip 9ea12b5`,
  132/132 tests; solo falta la verificación E2E y el cierre — ver `thesis-harnesss/To Do.md`
  sección 0). Especificación original: `commit_sha` en memory/decision;
  `headSha`/`resolveRef` en `util/git.ts`; estampado en `versioning.ts` +
  `MemoryStore.upsertMemory`/`ADRStore.upsert` (explícito > default); synthesizer
  propaga `{actor,branch,commit_sha}`; `synthesize --at <ref>`; `branch sync --reindex`;
  enum `status`+`deprecated` + `deprecation_reason`/`superseded_by`/`review_after`/
  `components[]`; tool `deprecate_decision` + `aitl adr deprecate`; hydrate excluye
  deprecados/superseded/vencidos y devuelve `needs_review`; `proposeDeprecations`
  (solo propone); badges en DecisionsView. E2E sobre proyecto `e2e-p3-test`.
  **Al cerrar**: verificar → commit → ADR 0049(+) + espejo `docs/adr/` + ledger en
  CLAUDE.md + fila(s) en bitácora de la tesis.

## Cola (orden)
1. **P3.5** (pedido del usuario, no lanzar hasta cerrar P3 — choca en cli.ts/App.tsx/api.ts):
   registro de usuarios web+CLI (`aitl user register`; email/username únicos con
   índices y 409), `AITL_WEB_ALLOW_SIGNUP` (default on), primer usuario real→admin;
   pestaña **Config** en la web UI (backends/modelo/keys enmascaradas) que persiste en
   `~/.aitl/config.json` **y espeja claves al `.env` del proyecto en automático**;
   `PUT /api/config` gated (root allow, admin delegated), auditado.
   *Interpretación de «.env en automático» = espejo de config; confirmar con el usuario.*
2. **P4** sync markdown bidireccional (`src/sync/{export,sync}.ts`, manifiesto
   `.aitl/.sync-state.json`, `--pull`/`--push`, backfill `docs/adr/`).
3. **P5** degradación sin LLM (fallback unificado en `run`) + `aitl init` idempotente
   (DB, jerarquía, index-repo, seeds, CLAUDE/AGENTS, `.mcp.json`, hooks host,
   post-merge, `--memory-only`).
4. **P6** module map (`repomap --modules`, view/back/mixed/infra, `module-brief`).
5. **P7** coordinación (taskClaim/coordEvent, claim/release/poll, `aitl coord poll`).
6. **P8** council plan-council (ports/adapters/rubric/orchestrator, `aitl council`).
7. **P9** TUI rama Task (Planear→sdd / Delegar→run-host / Council si ≥2 hosts).
8. **P10-harness** consolidar `docs/ARQUITECTURA*.md`, archivar docs/thesis+sessions.
9. **P11 tesis**: T5 THESIS-STATE.md → T2 chapter-03 (6 puntos; LangGraph cita
   IMPL-0047; v2 según P7/P8) → bitácora 0049+ → T6 humanizar + latexmk final.

## Medición (`../metricas/`, la hace el usuario en otro chat)
- raytracer: **listo** — `sdd/phase-00…05` + ramas `fase-N/{c0-bare,c2-harness}`.
- schoolmx: `sdd/` **vacío** — redactar SDDs (T1 validaciones, T3 tenant isolation)
  con el patrón del raytracer + ramas.
- Flujo por corrida: checkout rama → C0 `aitl run --bare --verify-cmd` / C2 default
  (o `run-host`) → `aitl run-show` → `tab:metrics` (cap. 4) → cap. 5 a resultados reales.
- H8: documentar ≥1 conversión fallo→guía. H9: repetir subset con segundo modelo.

## Convenciones de cierre por fase
`npm run verify` verde + E2E dirigida + `record_decision` (id contiguo next-free) +
espejo markdown en `docs/adr/` + commit en `feat/harness-v2` + fila en la bitácora de
la tesis. Prosa nueva de la tesis con `skills/academic-thesis-humanizer/SKILL.md`.
