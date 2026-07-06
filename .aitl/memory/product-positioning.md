---
name: product-positioning
description: >-
  Posicionamiento del producto: sistema cognitivo dual (harness propio + backend
  MCP)
type: project
category: decision
tags:
  - positioning
  - vision
  - harness
  - mcp
  - hosts
version: 1
updated_at: 2026-06-24T14:47:36.390Z
---
Posicionamiento elegido (2026-06-24): SISTEMA COGNITIVO DUAL. Dos caras sobre la misma capa de estado durable:
- Cara A — Harness propio: corre agentes él mismo (runAgent/orchestrate), con modelos crudos vía OpenRouter (único provider de modelo).
- Cara B — Capa cognitiva: corre SOBRE hosts de agente externos (codex, claude-code, antigravity) vía HostAdapters (runOnHost), añadiéndoles memoria/contexto/telemetría durables; y sirve ese estado a otros agentes vía el servidor MCP.

Decisión de providers: se eliminaron Gemini/OpenAI/Anthropic como providers de modelo crudo; queda solo OpenRouter (un gateway OpenAI-compatible para todos los modelos). Los agentes-host se manejan con HostAdapter, no como providers. Ver ADR 0019 (OpenRouter) y ADR 0020 (consolidación + HostAdapters).
