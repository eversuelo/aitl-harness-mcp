# ADR-0052 — aitl init: bootstrap de repo en un comando (idempotente, merges conservadores, hooks de host y post-merge) + degradación explícita sin backend de modelo

- **Status:** accepted
- **Date:** 2026-07-06

## Context

Inicializar el harness en un repositorio nuevo era un ritual manual de 6+ comandos (init-db, software/repo/branch add, index-repo, build seed, role seed, init claude/agent, .mcp.json y hooks a mano) sin idempotencia ni orden documentado — la fricción contradecía el objetivo de que cualquier repo de medición (raytracer, Schoolar) entre al harness en minutos. Además la degradación sin LLM era inconsistente: chat usaba la cadena de fallback pero run --model auto recibía un solo provider (asimetría de ADR-0044), y sin ningún backend los comandos morían con stack trace en vez de orientar (el modo memoria/Cara B funciona sin modelo).

## Decision

(1) F9: getProvider("auto") delega en getProviderWithFallback — un solo punto arregla run/orchestrate/sdd/review; nombres explícitos intactos. NO_BACKEND_MESSAGE accionable (configurar keys / provider local / modo memoria / run-host) con exit 1 limpio; synthesize sin backend avisa "síntesis extractiva" y continúa. Confirmado provider-free: search, hydrate, capture-session, sync, adr, memory history. (2) F1: `aitl init` como action del comando padre (subcomandos agent/claude intactos; enablePositionalOptions() arregla un bug real de commander donde las opciones del padre se tragaban las del hijo) — orquestador idempotente initRepo() con seam inyectable InitServices y reporte [ok|skip|done] por paso: DB (colecciones+índices extraído a src/db/init.ts, índice vectorial best-effort, bootstrap root), identidad software→repo→branch, indexRepo con skip inteligente, seeds build/role, guías CLAUDE.md/AGENTS.md con merge-sin-pisar (sección AITL única; --force sobrescribe), .mcp.json y .claude/settings.json con merges JSON conservadores (hooks UserPromptSubmit→hydrate y Stop→capture-session añadidos sin reemplazar; JSON inválido → no se toca), .git/hooks/post-merge ejecutable → branch sync --reindex best-effort (|| true; --root "$(git rev-parse --show-toplevel)" porque npm --prefix cambia el cwd), --memory-only salta la validación de provider y reporta qué funciona sin modelo, resumen de próximos pasos. Ruta del harness resuelta desde import.meta.url (npm --prefix <root> run …) — sin requerir bin global. init permanece en NO_DB_COMMANDS; el padre abre su propia conexión fail-fast.

## Consequences

- Un repo de medición entra al harness con UN comando; la segunda corrida es todo-skip (idempotencia verificada E2E en un repo git temporal: guías, .mcp.json, settings con hooks, post-merge, y en Mongo software/repo/branch/símbolos/seeds).
- El modo memoria (Cara B pura) es un estado de primera clase: sin backend, run/chat orientan en vez de tronar, y el resto de la superficie opera.
- verify 183/183 (7 tests nuevos de merges/idempotencia). Ingest de init acotado a .aitl/memory (evita node_modules y duplicar ADRs).
- Deuda: comando init-db sigue fallando duro sin Vector Search (solo script/orquestador usan la versión best-effort); rutas absolutas al harness en .mcp.json/hooks son machine-local (un bin global las simplificaría); host codex sin mecanismo de hooks (solo AGENTS.md); marcador de merge de guías amplio a propósito.
