---
name: estado-harness-2026-06-28
description: >-
  Estado autoritativo del harness al 2026-06-28 (post H11): plataforma 0024-0032
  + ROLES H11 (0033) cerrados; tesis ahora con artefacto de roles; piloto a una
  key.
type: reference
category: decision
tags:
  - session-2026-06-28
  - estado-harness
  - synthesis
  - h11-roles
  - adr-0033
  - metricas
  - pilot
version: 1
updated_at: 2026-06-28T16:37:42.580Z
---
ESTADO AUTORITATIVO AITL-Harness 2026-06-28 (actualiza versiones previas; ver [[session-synthesis-2026-06-28]], [[pilot-t1-t3-ready-0032]], [[roles-h11-cerrado-0033]]).

== CAMBIO MAYOR: H11 (roles) YA NO está ausente ==
Antes la auditoría dictó "DESVIADOS: core de tesis ausente (roles H11, C1 models, C4 tasks)". Roles H11 quedó CERRADO con ADR-0033. Siguen ausentes C1 (colección models+binding) y C4 (tasks/get_run_trace/get_task_tree).

== COMPLETO Y USABLE ==
- Núcleo MVP: hexagonal (ProviderPort/ToolRegistry/MemoryStore/ContextManager); aitl run (ReAct)/run-host/orchestrate; hydrate vector→texto→recencia + synthesizer; DefinitionStore/ADRStore/PromptStore/RepoMap; MCP stdio+HTTP; gates; events; UI web+TUI; OpenRouter único provider; Atlas único store; embeddings MiniLM/Voyage.
- Plataforma 0024-0032: RBAC+gateway(0024), graphify port(0025), auto-bootstrap(0026), versionado *_history(0027), jerarquía software/projects/repos+sub-scope repo(0028), knowledge map(0029), skills-meta build/index-repo(0030), branches graph(0031), instrumentación piloto(0032).
- ROLES H11 (0033): src/roles/{schema,store,engine,seed}. Rol = persona/lens+modo(review|pair|gate)+severidad+triggers+denyGlobs+skills+binding, en colección agents (metadata.kind=role). 3 acoplamientos: gate=veto determinista en loop (sin modelo, atribuido [role:x]); review=checkpoint fin-de-run; pair=advisory. Produce DecisionBrief (stance/findings/recommendation por rol) que ASISTE al ingeniero (no decide). Eventos review/role_veto/deliberation. Catálogo seed: security/devops/qa/architect/devsecops. CLI: aitl role {seed,list,rm,gate-check}, aitl review <target|@file> --roles, aitl run --roles. MCP: list/write/seed_roles. Verificado: gate-check VETO .env / ALLOW src/app.ts; 40 tests.

== MÉTRICAS Tabla 4.3 que captura el harness ==
#1 velocidad (duration en run-show) ✅; #2 calidad %pruebas (gate pass/fail vía --verify-cmd; % externo) 🟡; #3 regresiones (externo) 🔴; #4 mantenibilidad (externo) 🔴; #5 seguridad (role_veto/gates + validateTenantIsolation slice) 🟡; #6 supervisión humana (NUEVO: aitl intervene → evento human_intervention; run-show count+minutes) ✅; #7 eficiencia tokens/tool_calls/iters (rollup+run-show) ✅; #8 memoria (hydrate en run-show) ✅; #9 trazabilidad (events incl. objeciones de rol) ✅.

== PILOTO ==
examples/schoolar-mvp (T1 gate RED 3/4, T3 validateTenantIsolation RED 0/3). Schoolar real = schoolmx/schoolar-backend-saas (NestJS, módulos tenant/students, class-validator, 0 tests → falta escribir el gate de aceptación + pnpm install). Ray-tracer (Code/ray-tracing-express) lo alista el usuario. C2=aitl run default, C0=--bare. Hoja docs/metric-sheet.md v2. BLOQUEADOR para primer dato real: OPENROUTER_API_KEY (o run-host).

== DOCS ==
README.md, Functions.md, src/README.md actualizados (ciclo 0024-0033 + roles + medición). CLAUDE.md ledger → próximo ADR 0034. ADRs .md presentes 0001-0009+0026-0031; FALTAN exportar 0010-0025, 0032, 0033.

== PENDIENTES ==
- Construir C1 (models+binding) y C4 (tasks+traza MCP) si se quiere cubrir todo el core del DoD (roles ya hechos).
- Schoolar real: install + tests aceptación T1/T3 (class-validator, unit) + SDDs.
- Exportar ADRs faltantes a .md; rotar password Mongo (git ya limpio); hook seed pendiente de pegar.
- Tesis (cap 1-3): reconciliar alcance §1.8.2 (RBAC built=v2 desmontable), definir C0/C1/C2 en cap1, esquema numeración ADR; cap2 añadir multi-agente/Reflexion/vector-DB; cap3 demarcar MVP vs v2 vs diseñado, callout Tabla 3.1 vs 3.2, TODO(cita) 548. H11 ya tiene artefacto → la hipótesis es defendible.

PRÓXIMO: primer dato real (key) o construir C1/C4; y reparaciones de tesis cap 1-3 (las hace el usuario).
