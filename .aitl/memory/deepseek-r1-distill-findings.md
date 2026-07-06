---
name: deepseek-r1-distill-findings
description: >-
  Hallazgos live del deepseek-r1-0528-qwen3-8b vía LM Studio: sin tool calling,
  reasoning_content separado, perfil de tokens
type: reference
category: uncategorized
tags:
  - lmstudio
  - deepseek-r1
  - models
  - tool-calling
  - pilot
version: 1
updated_at: 2026-07-02T17:36:16.782Z
branch: master
---
Pruebas live (2026-07-02) de deepseek/deepseek-r1-0528-qwen3-8b en LM Studio (RTX 4050, ctx 8192):

1. **NO hace tool calling**: con tools declaradas (formato OpenAI function), incluso con system prompt "You MUST use the provided tools", devuelve finish_reason=stop, tool_calls=[] y content VACÍO (solo quema reasoning tokens). → INUTILIZABLE para el loop `aitl run`/`aitl chat` con tools. Confirma la debilidad conocida de los distills R1.
2. **LM Studio separa el razonamiento**: la respuesta trae `reasoning_content` aparte y `content` limpio (sin fuga de <think>). El OpenAIProvider del harness lee choices[0].message.content → no necesita cambios.
3. **Perfil de tokens carísimo**: respuesta de 1 línea = 405 completion tokens, de los cuales 339 (84%) fueron reasoning (usage.completion_tokens_details.reasoning_tokens). Presupuestar maxTokens generoso (los reasoning tokens cuentan contra max_tokens) y esperar latencia alta.

**Uso viable en la matriz** ([[pilot-model-matrix-6gb]]): solo pasos sin tools — `aitl sdd` (spec→design→decompose), síntesis del orchestrator, roles review. Como condición "razonador" de la tesis vale justamente para mostrar que razonar ≠ operar tools.
