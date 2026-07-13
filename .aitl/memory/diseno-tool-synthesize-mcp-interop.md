---
name: diseno-tool-synthesize-mcp-interop
description: >-
  IMPLEMENTADO (ADR-0071, 2026-07-11): tools MCP synthesize + coord_status +
  publish_event (52→55) con verificación E2E por cliente en memoria; providers
  recableados a Chutes (slot openai-compat, key inerte en API_KEY corregida, LM
  Studio retirado, MODEL_PRIMARY=openai-compat); evolución push/leases/DAG en
  ADR-0072 proposed.
type: project
category: reference
tags:
  - session-2026-07-11
  - interop
  - synthesize
  - coordinacion
  - providers
  - chutes
  - adr-0071
  - adr-0072
  - 'component:src/mcpserver'
  - 'component:src/coord'
  - 'component:src/memory'
version: 2
updated_at: 2026-07-12T00:06:13.018Z
branch: feat/harness-v2
commit_sha: db899ce2e2c5c8a82cd59d5cf7404c66a522b3fb
---
INTEROP MULTI-HARNESS — diseño → IMPLEMENTADO (ADR-0071 accepted; evolución en ADR-0072 proposed). Contexto de sesión en [[siembra-skill-router-2026-07-11]].

== LO IMPLEMENTADO (2026-07-11) ==
1. Tool `synthesize` {project, provider: auto|anthropic|openrouter|lmstudio|openai-compat|extractive, force=true, compact=false, return_text=true} — RBAC memory:update. El "agente sintetizador" es el provider del SERVER elegido POR INVOCACIÓN (Synthesizer ya aceptaba Provider inyectable, synthesizer.ts:96-101); auto usa getProviderWithFallback y degrada a extractivo sin backend; provider explícito inexistente lanza error accionable. Devuelve slugs + stats + cuerpos (cap 8k) → re-ingreso INMEDIATO al flujo del llamador + durable vía hydrate. Las keys viven en el server: Codex/OpenCode pueden sintetizar con haiku sin tener key propia.
2. Tool `coord_status` {project, events_limit=20, include_history} — read-only: claims activos (listClaims) con expires_in_ms, eventos recientes desc, actores (dueños∪actores, last_seen, open_claims). Responde "¿quién más trabaja en este codebase y en qué?" — necesidad demostrada por la sesión paralela ajena (adrGuard) de hoy.
3. Tool `publish_event` {project, type: note|task_done|decision, task_key?, payload} — expone recordCoordNote (best-effort, {ok:false} en vez de lanzar); RBAC coordination:create. Completa el bus pull: claim/release/publish/poll/status.
4. Providers: .env del repo → Chutes por slot openai-compat (BASE_URL=https://llm.chutes.ai/v1, MODEL=default, la key MIGRADA de la variable inerte API_KEY que el harness no lee — cpk_* no se auto-clasifica, solo sk-ant-*/sk-or-*); MODEL_PRIMARY=openai-compat (decisión del usuario: determinista, solo OpenAI-compat+Anthropic); slot ANTHROPIC_* listo vacío; LMSTUDIO_* retirado del .env Y de ~/.aitl/config.json global (seguro: ADR-0067 re-autodetecta el modelo cargado vía URL default cuando el server local corre — el laboratorio raytracer no se rompe). Guía nueva docs/PROVIDERS.md; .env.example ampliado (ejemplos Chutes/OpenAI).

== EVIDENCIA E2E ==
Cliente MCP en memoria (InMemoryTransport) contra buildServer(): 55 tools registradas; publish_event → ok:true con telemetría runLogged tool:start/end; coord_status proyecta los eventos decision reales de ADR-0069/0070; synthesize extractivo limpio en proyecto vacío (written:[], synthesizer:"extractive"). aitl models → openai-compat activo único; auth Chutes HTTP 200. Suite 439/439 + build.

== WEBSOCKET / PUSH (respuesta técnica, base de ADR-0072) ==
MCP es request-response (sin webhooks/pub-sub en el protocolo; Streamable HTTP permite notificaciones pero el soporte de los hosts es inconsistente). Y aunque hubiera push, el LLM solo escucha en FRONTERAS DE TURNO — el push le sirve al wrapper/harness, no al modelo. Patrón correcto: modelo en pull (coord_status al abrir + hook Stop coord poll, ya cableados) + canal SSE/WS para wrappers (change streams sobre coord_events; atlas-local es replica set de 1 nodo). Eso + leases por archivo + detect_conflicts + DAG = ADR-0072 (proposed), la capa AACL como contribución de tesis.
