---
name: pilot-t1-t3-ready-0032
description: >-
  Piloto T1+T3 listo para medir (ADR-0032): slice, condiciones C0/C2, run-show y
  --verify-cmd. Único bloqueador: OPENROUTER_API_KEY.
type: project
category: decision
tags:
  - session-2026-06-28
  - pilot
  - adr-0032
  - t1
  - t3
  - blocker-openrouter-key
  - 'component:examples/schoolar-mvp'
  - 'component:src/orchestration'
version: 1
updated_at: 2026-06-28T16:04:48.049Z
---
Actualiza [[session-synthesis-2026-06-28]]: T3 ya NO está pendiente. Tras analizar la tesis (DoD Cap.4/ADR-0001: aceptación + quality gate verde + trazabilidad + telemetría; piloto = T1+T3 × C0/C1/C2 × 2 = 12 corridas) se completó la instrumentación del piloto (ADR-0032):

- examples/schoolar-mvp ahora tiene T1 (student.ts/student.test.ts, Zod, gate `npm run test:t1`, RED 3/4) y T3 (tenant.ts findStudentsByTenant + validateTenantIsolation + tenant.test.ts, ADR-SCH-002, gate `npm run test:t3`, RED 0/3 por fuga en el stub).
- aitl run-show <runId>: tokens.total/tool_calls/iters/event_counts/hydrate (rollup persistido en el doc del run).
- Condiciones: C2 = aitl run (default); C0 = aitl run --bare (off hydrate/skills/gates).
- Quality gate en el loop: aitl run --verify-cmd "<cmd>" (reusa opts.verify de runAgent; el run no termina hasta exit 0 -> 'éxito alucinado' measurable).
- docs/metric-sheet.md = hoja v2. CLAUDE.md next-free ADR = 0033.

BLOQUEADOR ÚNICO para correr el primer C0/C2: falta OPENROUTER_API_KEY (o usar aitl run-host --host claude-code).
PENDIENTES no críticos: C1 (memoria de sesión sin persistencia) sin operacionalizar; validate_tenant_isolation como tool MCP (hoy es función del slice); T3 sobre Mongo con tenantId+índices (hoy in-memory); reparaciones de la auditoría (Functions.md/src/README/export ADRs .md 0010-0025) sin ejecutar; rutas relativas del repomap (posible ADR futuro); rotación del password Mongo (git ya limpio).
