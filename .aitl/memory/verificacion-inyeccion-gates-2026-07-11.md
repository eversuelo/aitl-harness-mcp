---
name: verificacion-inyeccion-gates-2026-07-11
description: >-
  Mapa verificado de las 3 superficies de inyección y 6 quality gates, con los
  13 hallazgos de confiabilidad de la sesión 2026-07-11 (pair=review, triggers
  muerto, __global__ no enrutado, RBAC incompleta, routeSkills sin tests, etc.)
  y qué se arregló.
type: reference
category: bug
tags:
  - session-2026-07-11
  - verificacion
  - inyeccion
  - quality-gates
  - pair-programming
  - 'component:src/orchestration'
  - 'component:src/projectctx'
  - 'component:src/hosts'
  - 'component:src/mcpserver'
version: 1
updated_at: 2026-07-11T23:33:46.415Z
branch: feat/harness-v2
commit_sha: 7bca160c7f6be4112677a147c745169bec547b14
---
VERIFICACIÓN DE INYECCIÓN Y GATES (2026-07-11, ADR-0069). Detalle de siembra en [[siembra-skill-router-2026-07-11]].

== MAPA DE INYECCIÓN (3 superficies, evidencia file:line) ==
1. Loop interno (aitl run/chat/orchestrate, MCP run_agent) — src/orchestration/graph.ts: system = [hydrate (l.352) + skills routeSkills (l.358-368, heading "## Project skills…") + agents routeSkills (l.369-386, filter metadata.kind!=="role", heading "## Project agents…") + opts.system].join("\n\n") (l.388). Roles OPT-IN via opts.roles (l.254-269): gate→roleGate determinista instalado como PermissionGate; review/pair→deliberate() al cierre (l.773-782). aitl chat: hydrate/skills SOLO primer turno (repl/chat.ts:492).
2. run-host (hosts externos) — hosts/run.ts:100-108: SOLO hydrate, prepend al prompt user. NI skills NI agents NI roles llegan a Claude Code/Codex. --no-hydrate solo aquí (cli.ts:541-544, ADR-0068). En aitl run el equivalente es --bare (hydrate+skills+gates off juntos; sin flags individuales).
3. Hook aitl hydrate (cli.ts:2075) — stdout para UserPromptSubmit; solo hydrate.

== HALLAZGOS (13) ==
F1 pair_programming NO cumple su función documentada: mode "pair" se ejecuta IDÉNTICO a review (graph.ts:774 filtra review||pair juntos → una crítica al final); el "acompañamiento tras cada edición" del docstring (roles/schema.ts:6-9) no existe. F2 role.triggers es campo MUERTO: solo se serializa (roles/store.ts:22,45), nada lo lee. F3 routeSkills (Pilar 3) tenía CERO tests y runAgent no tiene test de integración → ARREGLADO parcialmente: src/projectctx/router.test.ts nueva (selección/fallback/filtro roles/presupuesto); integración runAgent sigue pendiente. F4 micro-bug del router: content.slice(0, presupuesto-negativo) inyectaba fragmento basura → ARREGLADO (Math.max(0,·), router.ts:135). F5 TOOL_RBAC violaba su contrato: write_agent/write_skill/delete_agent/delete_skill/save_mcp_context/record_human_intervention mutaban SIN gate (auditor read-only podía escribir) → ARREGLADO (+6 entradas, tabla exportada, canario rbac.test.ts con biyección de 25 mutantes). F6 conventions: colección vacía y loadConventions sin superficie CLI/MCP → SEMBRADA (8 reglas desde AGENTS.md §Conventions), pero sigue sin comando (pendiente). F7 skills __global__ no se auto-enrutan (candidateSkills solo consulta el project del run; adr-ledger-reconcile inerte en ruteo; E6/ADR-0038 pendiente). F8 run_agent MCP no expone roles (solo CLI aitl run --roles). F9 PhaseGate = código muerto (hooks/gates.ts:36-51, sin consumidores). F10 hook de aitl init sigue en UserPromptSubmit contradiciendo ADR-0023 (SessionStart) — initRepo.ts:377; reconciliar (¿supersede o fix?). F11 las 4 tools de versiones (list/get_decision_version, list/get_memory_version) no pasan por runLogged → sin telemetría mcp_tool_calls. F12 list_agents devuelve TAMBIÉN roles (kind:role) sin filtro. F13 espejo docs/adr estaba en 0061 vs ledger 0068 con 3 afirmaciones de contigüidad distintas en docs → re-sincronizado esta sesión.

== QUALITY GATES (6 mecanismos, todos con tests unitarios; verificados) ==
PermissionGate (tools/base.ts:118-131; default deny .git/.env/keys); verify-cmd/verifiers con stop_reason completed|max_iters|verify_exhausted|stalled|budget y verified nunca disfrazado (graph.ts:416-448,534-543); LoopSpec+budgets+stall+reflect (ADR-0062); roles gate (VETO en vivo: "VETO .env — [role:security] path/command blocked by policy: *.env" / ALLOW src/cli.ts); approval --ask; council (quórum≥2, anonimato, juez≠proponentes).

== EVIDENCIA E2E VIVA (post-siembra) ==
router skills → [memoria-sesion, repo-indexer, skill-router]; router agents → [harness-engineer] (5 roles excluidos); hydrate sections {memory:6, decisions:5, conventions:8, repomap:1} — PRIMERA VEZ con las 4 secciones. Suite 438/438 (antes 401; +37 tests nuevos).
