# ADR-0032 — Instrumentacion del piloto: slice T1/T3, condiciones C0/C2, run-show y quality gate en el loop

- **Status:** accepted
- **Date:** 2026-06-28

## Context

El primer testing de la tesis (piloto) es 2 tareas (T1 alta-de-alumno, T3 aislamiento-por-tenant) x 3 condiciones (C0/C1/C2) x 2 repeticiones = 12 corridas. DoD por corrida (Cap.4/ADR-0001 de la tesis): criterios de aceptacion + quality gate verde + cadena de trazabilidad + telemetria (tokens/iteraciones/tool_calls/intervenciones). El harness no exponia: total de tokens por run, condiciones C0/C2 operacionalizadas, ni la tarea T3 con su tool validate_tenant_isolation (ADR-SCH-002, metrica Seguridad de la Tabla 4.3).

## Decision

Se construyo la rebanada vertical minima medible en examples/schoolar-mvp (self-contained, gate via node --test): T1 (src/student.ts stub + student.test.ts, validacion Zod, 4 criterios) y T3 (src/tenant.ts findStudentsByTenant stub + validateTenantIsolation + tenant.test.ts, ADR-SCH-002). Ambas arrancan RED (maker=agente, checker=tests). Gates por tarea: npm run test:t1 / test:t3. Instrumentacion de medicion: (1) rollup por run en runAgent (token_usage{input,output}, iters, tool_calls, gate_denials persistidos en el doc del run) + comando aitl run-show <runId> (tokens.total, tool_calls, iters, event_counts, hydrate). (2) Condiciones: C2 = aitl run default (hydrate+skills+gates+traza); C0 = aitl run --bare (apaga hydrate/skills/gates). (3) Quality gate en el loop: aitl run --verify-cmd "<cmd>" usa el opts.verify existente de runAgent para que el run solo termine cuando el comando sale 0 -> convierte el DoD en condicion de terminacion y hace 'exito alucinado' measurable. Hoja de medicion v2 en docs/metric-sheet.md. Invariante desmontable: RBAC/jerarquia/branches no entran al loop, no inflan el C2 medido.

## Consequences

El piloto es ejecutable y medible salvo por un bloqueador externo: falta OPENROUTER_API_KEY (sin el, el loop de aitl run no llama a un modelo); alternativa aitl run-host --host claude-code. C1 (estructurado, memoria de sesion sin persistencia) queda sin operacionalizar (pendiente para el piloto completo de 3 condiciones). T3 valida aislamiento en memoria (suficiente para el unit-gate); la version Mongo con tenantId+indices compuestos (ADR-SCH-002 completo) es posterior. validate_tenant_isolation existe como funcion del slice, no como tool MCP todavia. Verificado: typecheck/build limpios, 37 tests harness verdes; T1 RED 3/4; T3 RED 0/3; --bare/--verify-cmd en run --help; run-show probado. Diseno DSR: operacionalizar las condiciones experimentales como banderas del mismo loop (no runtimes paralelos) y el DoD como verifier de terminacion hace la medicion reproducible y la separa del modelo. Proximo: definir la key y correr C0 vs C2 de T1/T3 con la hoja v2; o construir el core ausente (C1 models, C4 tasks, E1-E3 roles) detectado en la auditoria.
