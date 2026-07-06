---
name: roles-h11-cerrado-0033
description: >-
  H11 cerrada (ADR-0033): roles componibles review/pair/gate que asisten al
  ingeniero con DecisionBrief; + métrica supervisión humana.
type: project
category: decision
tags:
  - session-2026-06-28
  - h11
  - roles
  - adr-0033
  - 'component:src/roles'
  - 'component:src/orchestration'
  - decision-brief
version: 1
updated_at: 2026-06-28T16:38:01.624Z
---
ADR-0033 — Roles de ingeniería (H11). Cierra la mayor brecha de tesis. Detalle en [[estado-harness-2026-06-28]].

Artefacto: src/roles/{schema,store,engine,seed}.ts. Rol = persona/lens + modo(review|pair|gate) + severidad(advisory|blocking) + triggers + denyGlobs + skills + binding(host,model). Vive en colección agents (metadata.kind=role), reusa DefinitionStore. Sin runtime paralelo, desmontable.

Tres acoplamientos al loop (E2): gate=PermissionGate determinista (veto sin modelo, razón atribuida [role:x]); review=crítica por modelo en checkpoint fin-de-run; pair=advisory continuo. deliberate() corre los roles, atribuye objeciones y emite eventos review/role_veto/deliberation, devolviendo DecisionBrief {verdicts[{role,stance approve|concerns|block,findings,recommendation}], blocked, summary}. Principio (petición del usuario): los roles ASISTEN al Software Engineer a decidir con mejor criterio, no deciden por él; blocked solo si rol blocking objeta.

Integración runAgent: opts.roles → gate-roles como PermissionGate; review/pair deliberan sobre finalText al cierre (run.roles, run.decision_blocked, result.decision_brief). Catálogo seed: security(gate/blocking), devops(review), qa(pair), architect(gate/blocking), devsecops(review). CLI: aitl role {seed,list,rm,gate-check}, aitl review <target|@file> --roles, aitl run --roles. MCP: list_roles/write_role/seed_roles.

Métrica Tabla 4.3 #6 (supervisión humana): evento human_intervention + aitl intervene <runId> --reason --minutes + MCP record_human_intervention; aitl run-show reporta human_interventions{count,minutes}, roles, decision_blocked, review_events.

Verificado: 40 tests; live sin key gate-check VETO .env (atribuido security) / ALLOW src/app.ts; seed 5 roles. review/pair (modelo) requieren OPENROUTER_API_KEY como el resto del loop. H11 ahora es EVALUABLE (worker-solo vs worker+roles, objeciones trazables).
