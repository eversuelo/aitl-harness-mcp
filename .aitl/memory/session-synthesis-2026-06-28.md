---
name: session-synthesis-2026-06-28
description: >-
  Síntesis de la sesión 2026-06-28 (Opus 4.8): ciclo 0026-0031, auditoría
  (veredicto: desviados del core de tesis), y MVP primer-testing (T1 listo,
  bloqueado por OPENROUTER_API_KEY).
type: project
category: reference
tags:
  - session-2026-06-28
  - synthesis
  - ciclo-0026-0031
  - audit
  - mvp-primer-testing
  - veredicto-desviados
  - 'component:examples/schoolar-mvp'
  - 'component:src/orchestration'
  - 'component:src/graph'
  - 'component:src/branches'
version: 1
updated_at: 2026-06-28T15:53:21.056Z
---
SÍNTESIS SESIÓN 2026-06-28 (Opus 4.8). Tres bloques: construcción, auditoría, MVP.

== 1. CONSTRUCCIÓN (ADRs 0026-0031, todos accepted, verificados contra Atlas, 37 tests) ==
- 0026 auto-bootstrap de root local (bootstrapBaseUser nunca throwea; AITL_BOOTSTRAP_AUTOGEN).
- 0027 versionamiento append-only ADRs/memoria (decisions_history/memory_history; version+actor+branch; aitl adr/memory history --diff; tools *_versions; src/memory/{versioning,history}.ts; src/util/diff.ts).
- 0028 jerarquía software->projects->repos (colecciones softwares/repos + CRUD MCP/CLI/RBAC) + sub-scope repo en memory/symbols/mcp_context.
- 0029 knowledge map multi-entidad (graphify extendido aditivo + pestaña UI con filtros; src/graph/knowledge.ts; /api/knowledge-graph).
- 0030 skills-meta: constructora (aitl build skill|agent, build_definition) + indexador maestro (aitl index-repo, index_repo) + seed (definition-builder, repo-indexer); src/builder/, src/indexing/.
- 0031 clasificación de ramas + grafo estilo GitHub (src/util/branches.ts classifyBranch; colección branches; sync por git fork-point; NodeKind+branch, EdgeKind+derives).
- CLAUDE.md: ledger 0001-0031, próximo ADR libre 0032. ADRs .md presentes solo 0001-0009 + 0026-0031.

== 2. AUDITORÍA (rama audit/ciclo-0024-0031) — VEREDICTO: DESVIADOS hacia roadmap/infra ==
- Core de tesis (DoD Ciclo 01) AUSENTE: C1 (colección models + binding agent-host-model), C4 (tasks + get_run_trace/get_task_tree), E1-E3 (roles pair-programming kind:role/review/pair/gate). C2 actor solo parcial (RBAC actor, no en runs/events).
- Escena DoD demostrable hoy ~10%: 0 de 5 pilares (models, 3 roles, task_tree). Solo fragmentos: branch/commit (0028/0031) y actor de auth (0024).
- Ratio últimos 8 ADRs: 1 core-tesis (0029) vs 7 roadmap/infra. => el corazón de la tesis sigue sin construirse.
- Deuda doc (verificada, NO reparada aún): Functions.md sin comandos nuevos; src/README.md sin auth/branches/softwares/repos/builder/indexing/versioning; docs/adr/README.md llega a ~0025; faltan .md de ADRs 0010-0025.
- ADR-0025 = "graphify desacoplado en módulo puro tras un port GraphSource" (ausente del índice).

== 3. MVP PRIMER-TESTING (rama mvp/primer-testing) — listo salvo el proveedor ==
- examples/schoolar-mvp/: SPEC.md + student.test.ts (checker, 4 criterios) + src/student.ts (stub=maker). Gate: npm test --prefix examples/schoolar-mvp -> RED 3/4 (el caso válido espera implementación). Misma base C0/C2; reset git checkout -- examples/schoolar-mvp.
- Instrumentación medible: rollup por run en runAgent (token_usage/iters/tool_calls/gate_denials en el doc del run) + comando aitl run-show <runId> (tokens.total, tool_calls, iters, event_counts, hydrate). Verificado con run sintético.
- Condiciones: C2 = aitl run (default hydrate+skills+gates+traza); C0 = aitl run --bare (apaga hydrate/skills/gates). Invariante "desmontable": RBAC/jerarquía/branches NO entran al loop, no inflan el C2 medido.
- docs/metric-sheet.md = hoja v2 (sddId+hash, reloj fijo, éxito-alucinado, baseline suite).

== PENDIENTES / GAPS (con su acción) ==
- BLOQUEADOR del primer C0/C2: falta OPENROUTER_API_KEY (sin él el loop de aitl run no llama modelo). Alternativa: aitl run-host --host claude-code.
- P0 seguridad: git LIMPIO (.mcp.json 0 hits + gitignored + .example creado); rotar password sigue recomendable (se mostró en sesión), no bloqueante.
- Hook SessionStart de seed (ADR-0030): bloqueado por clasificador auto-mode; pegar a mano (snippet en ADR-0030).
- Mejora anotada (no construida): exponer aitl run --verify-cmd para cerrar el loop solo con gate verde => convierte "éxito alucinado" de counted a measured.
- Repomap re-indexado en Linux (912 símbolos, incluye dist/=ruido). Recomendado (no hecho): guardar symbols.file RELATIVO al root para que sea portable entre hosts (el usuario alterna Windows/Linux) — sería ADR-0032.
- Reparaciones de la auditoría (Functions.md/src/README/índice ADR/export 0010-0025 .md) NO ejecutadas: el humano pidió stop-and-report y luego pivotó al MVP.

PRÓXIMO PASO MÁS PROBABLE: definir OPENROUTER_API_KEY y correr el primer C0 vs C2 de T1 con la hoja v2; o construir el core (C1 models, C4 tasks, E1-E3 roles) que la auditoría marcó como faltante.
