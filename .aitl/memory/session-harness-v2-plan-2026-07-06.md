---
name: session-harness-v2-plan-2026-07-06
description: >-
  Sesión harness-v2 PAUSADA por el usuario (2026-07-06): P0-P2 cerrados (ADRs
  0046-0048), P3 detenido con implementación completa verify-green en wip
  9ea12b5 (solo falta E2E + ADR 0049), P3.5 (registro usuarios + config web UI)
  especificada y en cola, luego P4-P11. Reanudar por thesis-harnesss/To Do.md
  sección 0.
type: project
category: task
tags:
  - session-2026-07-06
  - plan
  - feat/harness-v2
  - estado-sesion
  - paused
  - adr-0046
  - adr-0047
  - adr-0048
  - 'component:thesis-harnesss'
version: 3
updated_at: 2026-07-06T06:54:54.957Z
branch: feat/harness-v2
---
SESIÓN PAUSADA por el usuario 2026-07-06. Punto de reanudación canónico: **thesis-harnesss/To Do.md sección 0** (commit 5d12545). Espejo local: /home/eversuelo/Code/thesis-harness/PLAN-HARNESS-V2.md. Plan aprobado: ~/.claude/plans/necesitamos-dise-ar-la-t-sis-merry-babbage.md.

== CÓMO REANUDAR (en orden) ==
1. **Cerrar P3** — la implementación YA ESTÁ HECHA y verify-green (commit `wip 9ea12b5` en feat/harness-v2, typecheck + 132/132 tests). El agente fue detenido durante la verificación E2E. Falta SOLO:
   (a) E2E: escribir una memoria real (MemoryStore o MCP write_memory sobre un proyecto de prueba) y verificar commit_sha == `git rev-parse HEAD`;
   (b) round-trip: registrar decisión en proyecto e2e-p3-test, `aitl adr deprecate <id> --project e2e-p3-test --reason ...`, verificar status deprecated + versión bumpeada, y que `aitl hydrate --project e2e-p3-test` la excluye (vencidas → needs_review);
   (c) `aitl branch sync --reindex` dos corridas sobre el harness (1.ª guarda head/reindexa, 2.ª "sin cambios");
   (d) cierre: record_decision id **0049** (leer next-free primero) + espejo docs/adr/0049-*.md + nota ledger en CLAUDE.md del harness + fila IMPL-0049 en la bitácora de la tesis (y actualizar "cuarenta y ocho").
   Qué contiene 9ea12b5: commit_sha en memory/decision models; headSha/resolveRef en util/git.ts (+git.test.ts); estampado en versioning.ts + MemoryStore.upsertMemory/ADRStore.upsert (explícito>default); synthesizer propaga {actor,branch,commit_sha}; synthesize --at <ref>; src/branches/reindex.ts (branch sync --reindex); enum status+deprecated + deprecation_reason/superseded_by/review_after(TTL suave)/components[]; record_decision extendido + tool deprecate_decision + CLI aitl adr deprecate; hydrate excluye deprecated/superseded/vencidos y devuelve needs_review; src/decisions/lifecycle.ts proposeDeprecations (solo propone; 3 criterios) + lifecycle.test.ts; badges en DecisionsView (web/src/App.tsx).
2. **Lanzar P3.5** (pedido del usuario; task #13; NO se lanzó por choque de archivos con P3): registro de usuarios en web UI y CLI (`aitl user register`), email/username ÚNICOS (índices en db/indexes.ts + 409 en API), flag AITL_WEB_ALLOW_SIGNUP default on, PRIMER usuario real→admin (resto rol user, promoción con user set-role); pestaña Config en la web UI (estado de backends/modelo tipo `aitl models`, keys enmascaradas, campos editables AITL_API_KEY/MODEL_PRIMARY/LMSTUDIO_*/EMBEDDING_*/AITL_WEB_ORIGINS) que persiste vía la maquinaria de `aitl config set` (~/.aitl/config.json, ADR-0006) Y ESPEJA claves al .env del proyecto en automático (utilidad que reemplaza/añade líneas KEY= preservando el resto); PUT /api/config gated RBAC (config_secrets.update: root allow, admin delegated — extender matriz) + auditado. ADR nuevo al cerrar. NOTA: ".env en automático" es interpretación mía del pedido — confirmar con el usuario.
3. **Continuar cola**: P4 sync markdown → P5 degradación+init → P6 module map → P7 coordinación → P8 council → P9 TUI Task → P10-harness docs → P11 tesis (T5 THESIS-STATE, T2 chapter-03 6 puntos, bitácora 0050+, T6 humanizar+latexmk). Especificaciones detalladas por fase: versión 2 de esta memoria (list_memory_versions slug session-harness-v2-plan-2026-07-06) y PLAN-HARNESS-V2.md.

== CERRADO (no rehacer) ==
- P1 auth web ADR-0046 (cd76417+9c2720f): sessions opacas TTL, login/logout, 401/403 split, delegated para web autenticado, CORS allowlist, cliente web+LoginDialog. E2E Atlas ok. Usuario e2e-admin de prueba (borrar tras piloto).
- P2 infra ADRs 0047-0048 (ba603ce+d0e34e1+6d9c756): LangGraph fuera (runAgent único), conexión única Mongoose-dueño (getDb() no autoconecta), factories async validate(), quiet.ts fuera, eval retirado (C0/C2), mongodb@7 dedupe. verify 118/118 entonces; con P3 wip son 132/132.
- Tesis (master): 0634583 limpieza; 9dacf3d renumeración H1-H11; f7481c2 cap2 tab:cap2-frameworks + 5 bib; e7b4ac3 bitácora IMPL-0038..0046 + sec:impl-vivo; 392222a IMPL-0047/0048 ("cuarenta y ocho"); b9fb1d6/77e2436/5d12545 To Do.md vivo.
- Ledger ADRs contiguo 0001-0048, next free 0049. pnpm-lock.yaml sucio pre-sesión: NO commitear.

== CONVENCIONES ==
Por fase: npm run verify verde + E2E dirigida + record_decision (next-free) + espejo docs/adr + commit feat/harness-v2 + fila bitácora tesis + actualizar el conteo en prosa de la bitácora. Prosa tesis con skills/academic-thesis-humanizer. Clave MCP siempre project="aitl-js". Relacionado: [[thesis-drift-analysis-2026-07-05]], [[product-positioning]], [[project-identity]].
