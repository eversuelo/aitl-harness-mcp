---
name: openai-v4-premature-close-lmstudio
description: >-
  Bug determinista "Premature close" en streaming: openai SDK v4 vs LM Studio;
  fix = upgrade a openai v6 + retry transitorio + fixes REPL
type: reference
category: bug
tags:
  - lmstudio
  - openai-sdk
  - streaming
  - bug
  - debugging
  - chat
version: 1
updated_at: 2026-07-02T17:54:39.458Z
branch: master
---
Debugging live 2026-07-02: `aitl chat --model lmstudio` (deepseek-r1-0528-qwen3-8b) moría a mitad del stream con **"error: Premature close"**, determinista (cada intento).

**Aislamiento por capas** (misma petición, mismo server):
- curl -sN streaming → ✅ completa con [DONE]
- Node raw fetch/undici leyendo el body SSE → ✅ 53KB, [DONE]=true
- openai SDK **4.104.0** (el que usaba el harness) → ❌ Premature close en las 3 variantes (tools+usage / tools / plain)
- openai SDK **6.45.0** → ✅ las 3 variantes completan

**Causa raíz**: el parser de stream de openai v4 rompe contra el SSE de LM Studio. No era red, ni tools, ni stream_options, ni el modelo.

**Fixes aplicados**:
1. `openai` 4.104 → 6.45 en package.json. Breaking v6: `message.tool_calls` es unión (function|custom) → narrow `tc.type === "function"` con `ChatCompletionMessageFunctionToolCall` en OpenAIProvider.chat().
2. "premature close" / "other side closed" / "terminated" añadidos a isTransientError (src/util/retry.ts) — cortes de stream ahora reintentan el turno (los deltas pueden repetirse, la persistencia no).
3. REPL Ctrl+C: readline se traga SIGINT durante question() y el raw mode dejaba ^C sin efecto → handler en rl + process y setRawMode(false) tras cada question (src/repl/chat.ts).
4. Warnings de Mongoose (validateSync deprecado, Mongoose 9) ensuciaban el spinner → src/util/quiet.ts (process.noDeprecation) importado PRIMERO en cli.ts. Deuda real: migrar validateSync→validate en los 10 factories de src/models.
5. maxTokens de SDD subidos (spec 1500→3000, design 2000→4000, decompose 2000→4000) + error informativo en OpenAIProvider.complete cuando finish_reason=length y content vacío — los R1 queman el budget en reasoning_content y devolvían "empty design doc" críptico.
6. Bonus infra: `npm i -g .` + rebuild dejaba el bin global sin bit x (tsc escribe 644 y el global es symlink al proyecto) → scripts/fix-bin-perms.mjs en el build. El paquete npm se llama aitl-mcp, no aitl.

Verificado: typecheck limpio, 104/104 tests, build ok, stream test 3/3 con v6. Ver [[deepseek-r1-distill-findings]] para el comportamiento del modelo en sí.
