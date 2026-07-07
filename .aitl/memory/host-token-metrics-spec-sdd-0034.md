---
name: host-token-metrics-spec-sdd-0034
description: >-
  ADR-0034: tokens en run-host (Claude Code JSON) levanta el bloqueador del
  piloto + Pilar 4 SDD (specs auto-clasificados, persistidos y sintetizados con
  la tarea) + métricas en UI (pestaña Runs).
type: project
category: task
tags:
  - adr-0034
  - tokens
  - run-host
  - claude-code
  - sdd
  - spec
  - pilot
  - metrics
  - ui
  - cara-b
  - 'component:src/hosts'
  - 'component:src/specs'
  - 'component:src/server'
  - 'component:web'
version: 1
updated_at: 2026-06-29T15:48:34.854Z
branch: master
---
ADR-0034 (2026-06-29, accepted, verificado). Cierra dos huecos pedidos por el usuario. Resumen operativo:

== 1. TOKENS EN HOST RUNS (Cara B) — levanta el bloqueador del piloto ==
Antes solo `aitl run` (Cara A) medía token_usage. Ahora `aitl run-host --host claude-code` también:
- src/hosts/base.ts: HostResult +usage{input,output} +meta; CliHostSpec +parse(stdout); claude-code spec usa `claude -p --output-format json`; parseClaudeJson extrae result + usage(input_tokens+cache_creation+cache_read) + output_tokens + total_cost_usd + num_turns + duration_ms. CliHostAdapter parsea SOLO en exit 0 (best-effort; cae a texto crudo si el JSON no parsea).
- src/hosts/run.ts: escribe token_usage, host_meta, iters=num_turns, spec en el doc del run.
- aitl run-show: +host_meta +spec; aitl run-host imprime tokens/cost/spec/synthesis.
IMPACTO TESIS: métrica #7 (tokens/iters, Tabla 4.3) ahora se mide para Claude Code SIN OPENROUTER_API_KEY -> el piloto C0/C2 puede correrse por la vía alterna (ver [[pilot-t1-t3-ready-0032]], [[estado-harness-2026-06-28]]).

== 2. SPECS / SDD (Pilar 4 de [[plan-4-pilares]], antes sin construir) ==
- src/specs/classify.ts: classifySpec() puro, bilingüe ES/EN (heading spec, acceptance criteria/criterios de aceptación, user story/historia de usuario, gherkin given-when-then/dado-cuando-entonces, DoD, requirements, listas estructuradas). isSpec por señal fuerte+longitud>=200, score>=4, o >=3 señales+longitud. Sin flags (auto-clasificación, decisión del usuario).
- runOnHost registra SIEMPRE el prompt en colección `prompts` (source=host, run_id, tags [spec,sdd] vs [task], metadata: host/spec/spec_signals + al cerrar tokens/cost/status/synthesis_slug). Si es spec, escribe MemoryDoc type=synthesis (src/specs/synthesis.ts, slug spec-synthesis-<run8>, category=spec, tags synthesis/spec/sdd/run:<run8>) que une Spec + Outcome + Métricas; embebido y searchable. Síntesis DETERMINISTA por diseño (run-host no tiene Provider; escenario 'sin key'). Flags `--no-record-prompt`/`--no-spec-synthesis`.

== 3. MÉTRICAS EN UI ==
- src/server/api.ts: GET /api/runs?project= (lista) y GET /api/runs/:id (run + event_counts + intervention_minutes).
- web/src/api.ts: api.runs/api.run + tipos RunDoc/RunDetail.
- web/src/App.tsx: pestaña nueva "Runs" (icono BarChart3). Rollup agregado (N runs, Σ tokens, Σ cost), lista (modelo/host, status, tokens, cost, iters, badge spec), detalle (tokens in/out/total, cost_usd, iters/turns, tool_calls, gate_denials, duración, desglose de caché, roles, conteo de eventos, supervisión humana, session_id).

== VERIFICACIÓN ==
typecheck core+web verdes; build verde; vite build (1915 módulos); 44/44 tests (4 nuevos en src/specs/classify.test.ts). PENDIENTES: parsers JSON para codex/antigravity (hoy solo claude-code); tool_calls no observable desde el host (queda 0/null); opcional síntesis spec con modelo cuando haya Provider. CLAUDE.md ledger -> próximo ADR libre 0035.
