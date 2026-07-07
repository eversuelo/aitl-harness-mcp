---
name: project-identity
description: Clave canónica del proyecto en el backend aitl-js y su hash estable
type: reference
category: bug
tags:
  - project-identity
  - convention
  - mcp
  - hash
version: 1
updated_at: 2026-06-24T13:44:01.913Z
---
Clave canónica del proyecto en el backend MCP aitl-js: `aitl-js`. Hash estable: 79cdb3578a8f619c = sha256("aitl-js")[:16], anclado en AITL-Harness-JS/CLAUDE.md.

REGLA: toda tool del MCP aitl-js debe usar project="aitl-js". No usar variantes (AITL-Harness, AITL-Harness-JS) — fragmentan la historia.

Antecedente (2026-06-24): el estado durable se había partido entre `aitl-js` (historia real: ADRs 0001–0009, 19 prompts, contexto Codex) y una clave `AITL-Harness-JS` creada por error. Se fusionaron en `aitl-js`: los ADRs erróneos se renumeraron 0010–0013, se movieron memoria+prompt, y la clave errónea quedó vacía. ADRs ahora contiguos 0001–0013.
