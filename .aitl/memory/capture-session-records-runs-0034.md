---
name: capture-session-records-runs-0034
description: >-
  capture-session ahora registra un doc en `runs` con tokens reales del
  transcript de Claude Code (extiende ADR-0034 a sesiones humanas; puebla la
  pestaña Runs / run-show).
type: project
category: reference
tags:
  - adr-0034
  - capture-session
  - tokens
  - runs
  - claude-code
  - cara-b
  - metrics
  - 'component:src/context'
version: 1
updated_at: 2026-06-29T16:04:12.613Z
branch: master
---
Extiende [[host-token-metrics-spec-sdd-0034]] (ADR-0034) a las sesiones de Claude Code conducidas por humano (no por el harness).

PROBLEMA: la pestaña Runs salía vacía para project=aitl-js porque el trabajo se hizo con Claude Code directamente (no `aitl run`/`run-host`), y `captureSession` NO escribía en la colección `runs` ni leía `usage` del transcript.

CAMBIO (src/context/capture.ts):
- `parseTranscript` ahora acumula del JSONL: usage{input(=input_tokens+cache_creation+cache_read), output}, cache{creation,read,freshInput}, model, turns(=mensajes assistant), startedAt/endedAt (de los timestamps de línea). ParsedTranscript ganó esos campos.
- `captureSession` hace upsert de un doc en `runs` (_id=sessionId, model=host:<source>, status=done, token_usage, started/ended, iters=turns, host_meta{model,num_turns,duration_ms,cache,raw_input_tokens,captured_from:transcript}, spec=classifySpec(primer user msg)). Best-effort. CaptureResult +token_usage. CLI capture-session imprime tokens.

USO: `aitl capture-session --project aitl-js --transcript <~/.claude/projects/<dir>/<session>.jsonl> --session <id> --cwd <repo>`. Wírtelo como hook Stop (ver README "Forzar que Claude Code use siempre el MCP") para auto-registrar cada sesión.

OJO con la interpretación del total: token_usage.input SUMA cache_read de CADA turno (el contexto se re-lee por turno), así que infla. Ejemplo real de esta sesión (191 turns, opus-4-8): total 24.4M = cache_read 23.3M (barato, ~0.1x) + cache_creation 861k + fresh input 22.9k + output 217k. La "carga real" ≈ output + fresh + cache_creation ≈ 1.1M. El desglose vive en host_meta.cache para no engañar. La UI Runs muestra total + desglose de caché.

Verificado: typecheck+build verdes, 44/44 tests; run d4227793 (esta sesión) visible en run-show. Requiere reiniciar `aitl ui` para que la API tome GET /api/runs.
