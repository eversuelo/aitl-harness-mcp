# ADR-0022 — Inyección/captura de contexto en hosts externos vía hooks (aitl hydrate / capture-session)

- **Status:** accepted
- **Date:** 2026-06-25

## Context

La hidratación (hydrate, ADR-0012/0016) y la auto-síntesis (summarizeSession) solo corrían DENTRO de runAgent/run-host. Cuando el loop NO es el harness —p.ej. una sesión interactiva de Claude Code conducida por un humano (Cara B, ADR-0020)— no había forma automática de inyectar contexto durable ni de capturar lo hecho. El usuario pidió: cómo inyecto contexto cada que se toman decisiones o se hace algo relativo a un componente (p.ej. un refactoring). Faltaban (1) un punto de inyección por turno en el host, y (2) una noción de componente como unidad recuperable (aitl-js no tiene entidad componente de primera clase).

## Decision

Exponer dos comandos CLI best-effort y cablearlos como hooks de Claude Code en .claude/settings.local.json. (1) aitl hydrate [prompt] --project --no-vector --component imprime el preámbulo durable (memoria+ADRs+conventions+repo map) a stdout; lee el prompt del arg o del JSON del hook por stdin; --no-vector salta embeddings (ruta texto->recencia, la que corre igual hasta que exista el índice vectorial de Atlas, ADR-0010). Se cablea en UserPromptSubmit (su stdout se inyecta al contexto). (2) aitl capture-session lee el JSON del Stop-hook por stdin, parsea el transcript JSONL del host (src/context/capture.ts), lo resume en UN doc de memoria durable (summarizeSession) + un snapshot en mcp_context, auto-etiquetado por los componentes (directorios) editados (tag component:<dir>). Identidad de componente ambos: automática por directorio + nombre semántico opcional (--component / tag component:<nombre>). Cambios de núcleo aditivos: HydrateOpts.vector hilado en relevant(); summarizeSession acepta extraTags. Para que los hooks (procesos aitl fuera del MCP) conecten al mismo Atlas, se fijó MONGODB_URI/FALLBACK en ~/.aitl/config.json (perfil, ADR-0006). Protocolo de componentes documentado en CLAUDE.md.

## Consequences

Claude Code hidrata contexto relevante en cada prompt (UserPromptSubmit) y captura/etiqueta por componente al cerrar (Stop), sin pasar por runAgent — materializa la Cara B (ADR-0020) y la visión enforced-by-a-hook del ADR-0001. Verificado end-to-end contra Atlas: aitl hydrate --no-vector inyectó memoria(5)+ADRs+repo map; aitl capture-session con transcript sintético derivó component:src/projectctx, escribió el doc de memoria (tags session, host:claude-code, component:src/projectctx) y el snapshot mcp_context (recuperable por search_mcp_context, score 2.41); residuos de prueba borrados (memory=1, context=1); typecheck+build limpios. Limitaciones: (a) recall semántico/$text sobre español débil hasta crear el índice vectorial de Atlas (ADR-0010, P1) — hoy funcionan recencia y tag component:; (b) sin provider de clasificación el doc de Stop queda category uncategorized; (c) el repo map persistido incluye rutas absolutas y dist/ (ADR-0017, mejorable); (d) UserPromptSubmit añade latencia de conexión a Atlas por prompt — alternativa SessionStart documentada.
