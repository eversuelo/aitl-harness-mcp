# ADR-0043 — Contrato de round-trip provider↔loop: adaptar tool_calls y turnos vacíos (hallazgos de la primera corrida viva)

- **Status:** accepted
- **Date:** 2026-07-02

## Context

La primera corrida E2E real con modelo vivo (gemma-4 vía LM Studio, provider lmstudio de ADR-0038) destapó tres bugs que bloqueaban CUALQUIER corrida con tools en cualquier provider OpenAI-compatible — invisibles hasta ahora porque todo se había verificado con mock. Sin esto, --ask/hooks/cliente MCP (P1) eran inverificables end-to-end.

## Decision

(1) Round-trip de tool_calls: el loop persiste y reenvía los tool_calls del assistant en la forma normalizada del harness {id,name,input}, pero la API OpenAI espera {id,type:"function",function:{name,arguments:<json>}}. Nuevo helper exportado toOpenAiMessages en openai.ts adapta el convo de vuelta (content:null en turnos que solo llaman tools) antes de chat() y chatStream(). El segundo turno tras cualquier tool call fallaba con "Invalid 'messages' in payload". (2) MessageModel.content era required, que rechaza "" por truthiness de Mongoose — pero un turno assistant que va directo a tool_calls tiene texto vacío; relajado a default "". (3) decomposeTasks usaba un regex greedy /\[[\s\S]*\]/ que sobre-capturaba cuando el modelo añadía prosa con "]" sueltos; reemplazado por un extractor de array balanceado, consciente de strings y escapes.

## Consequences

El loop central funciona end-to-end con providers locales: write_file + streaming + --ask verificados sobre gemma-4 (run 082ba0ff creó el archivo en 2 iters; run 99e2ac87 denegó la escritura con gate_denials=1 y el modelo respondió 'denied'). 98 tests (6 nuevos: 3 del adaptador de mensajes, 1 de content vacío, 1 de prosa con brackets, +ajustes). Lección para la tesis: los tres bugs eran de round-trip/serialización invisibles al mock — evidencia directa del valor de la primera corrida viva (P0). Commit 9c2baf0 en feat/p1-p2-harness-core.
