---
name: context-injection-hooks
description: >-
  Hooks de inyección/captura de contexto para Claude Code: aitl hydrate +
  capture-session, tag component:<dir>
type: project
category: task
tags:
  - hooks
  - context
  - component
  - claude-code
  - cara-b
  - 'component:src/context'
version: 1
updated_at: 2026-06-25T03:01:50.673Z
---
Implementado 2026-06-24 (ver [ADR-0022]). Dos comandos CLI best-effort cableados como hooks de Claude Code en .claude/settings.local.json para inyectar/capturar contexto cuando el loop NO es el harness (Cara B, [ADR-0020]):

- `aitl hydrate [prompt] --no-vector --project aitl-js` → imprime preámbulo durable (memoria+ADRs+conventions+repo map) a stdout; lee prompt del arg o del JSON del hook por stdin. Cableado en UserPromptSubmit (su stdout se inyecta al contexto). --no-vector salta embeddings (texto->recencia).
- `aitl capture-session --project aitl-js` → lee Stop-hook JSON por stdin, parsea el transcript JSONL (src/context/capture.ts), resume en UN doc de memoria (summarizeSession) + snapshot mcp_context, auto-tag por directorios editados (component:<dir>). Cableado en Stop.

Núcleo aditivo: HydrateOpts.vector hilado en relevant() (src/memory/lifecycle.ts); summarizeSession acepta extraTags. Identidad de componente = ambos (dir automático + --component semántico opcional).

Para que los hooks (aitl fuera del MCP) lleguen a Atlas, MONGODB_URI/FALLBACK quedaron en ~/.aitl/config.json ([ADR-0006]). Limitación: recall semántico débil hasta el índice vectorial de Atlas ([ADR-0010]); hoy funcionan recencia y tag component:. Relacionado: [[product-positioning]], [[plan-4-pilares]].
