---
name: capture-session-runs-vacios-fix
description: >-
  Bug "runs no fue hidratada" (2026-07-12): capture-session manual sin
  --transcript ni hook escribía runs de puros ceros. Fix: findLatestTranscript
  (autodescubrimiento por cwd-slug), captureSession lanza error ante captura
  vacía (allowEmpty opt-in), CLI con mensaje accionable; 5 runs basura borrados
  y sesión re-capturada (22.1M tokens).
type: feedback
category: bug
tags:
  - capture-session
  - runs
  - bug
  - fix
  - adr-0034
version: 1
updated_at: 2026-07-12T04:50:31.488Z
branch: feat/harness-v2
commit_sha: f84b9037494c6e7c0f11c99c498e3169eb62b6ae
---
Reporte del usuario: «Parece que runs no fue hidratada» — la pestaña Runs de ray-tracer-learning mostraba runs sin datos.

**Causa raíz** (src/cli.ts capture-session + src/context/capture.ts): el comando obtiene el transcript de `--transcript` o del JSON del hook Stop por stdin. Invocado A MANO (sin hook, sin flag), `transcript` quedaba undefined y `captureSession()` construía el esqueleto vacío **y aun así escribía el run**: token_usage 0/0, iters 0, num_turns 0, artifacts vacíos, started_at==ended_at, `captured_from: "transcript"`. Hubo 5 runs así en ray-tracer-learning (04:15–04:18 del 2026-07-12; el orquestador paralelo reintentó varias veces porque la pestaña seguía vacía).

**Why:** el modo hook exige best-effort (nunca romper la sesión), pero ese contrato se aplicó también al modo manual, convirtiendo un error de invocación en basura silenciosa en la colección runs — la métrica #7 de la tesis se contamina con ceros.

**How to apply (el fix, verify 455/455):**
1. `findLatestTranscript(cwd, projectsRoot?)` en capture.ts: resuelve `~/.claude/projects/<cwd-slug>/*.jsonl` más reciente (prueba slug con `/`→`-` y variante con `.`→`-`); inyectable para tests.
2. `captureSession` LANZA error si no hay transcriptPath o si el parse da 0 turnos y 0 tokens, salvo `allowEmpty: true` explícito — jamás run de ceros silencioso.
3. CLI: si no vino transcript por flag ni hook, autodescubre por cwd y lo anuncia; si tampoco existe, mensaje accionable y NO escribe nada.
4. Remediación de datos: 5 runs vacíos de ray-tracer-learning borrados; re-captura con autodescubrimiento produjo el run real 15866d8c (22.1M in / 339k out, 3 memorias ligadas, snapshot ok).

Deuda cosmética detectada: componentTags marcó `component:tmp/claude-1000` porque los subagentes escriben en el scratchpad — convendría filtrar rutas fuera del cwd. Tests nuevos en src/context/capture.test.ts (3).
