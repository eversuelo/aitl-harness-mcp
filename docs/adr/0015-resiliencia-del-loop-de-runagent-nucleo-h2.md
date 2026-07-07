# ADR-0015 — Resiliencia del loop de runAgent (Núcleo H2)

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Núcleo H2 del plan reordenado. El loop real (runAgent) era un for en memoria sin tolerancia a fallos: provider.chat sin try/catch (un 429/5xx tumbaba el run y lo dejaba colgado en status 'running'), un tool que lanzaba reventaba el run, la única terminación era maxIters, y no había forma de reanudar un run interrumpido. El checkpointer de LangGraph existe pero solo para buildGraph, no para el camino real.

## Decision

Endurecer runAgent (src/orchestration/graph.ts) en cuatro frentes: (1) Reintentos: nuevo src/util/retry.ts (withRetry + isTransientError, backoff exponencial con jitter) envuelve provider.chat; cada reintento emite evento 'retry'. (2) Errores de tool: ToolRegistry.call captura excepciones del tool y devuelve '[tool error] ...' como resultado realimentado al modelo, nunca un crash. (3) Estado de fallo: el loop va en try/catch; un fallo no recuperable marca el run status='error' + error + ended_at y emite evento 'error', luego relanza (ya no se queda en 'running'). (4) Terminación por verificación: opts.verify((finalText,convo,project))→true|string; si no pasa, el feedback se reinyecta como turno de usuario y el loop continúa (acotado por maxIters), emitiendo evento 'verify'. (5) Resume por transcript durable (no LangGraph): se persiste tool_call_id en los mensajes de tool, MemoryStore.getMessages relee el transcript, y opts.resume=<runId> reconstruye el convo y continúa; emite evento 'resume'. RunAgentResult expone status. Eventos nuevos en el schema: retry, verify, error, resume.

## Consequences

runAgent tolera fallos transitorios, no se cuelga en 'running', sobrevive a tools que lanzan, puede cerrar por objetivo (no solo por límite) y reanudar runs interrumpidos desde su estado durable. El resume va por el transcript (que ya ES el checkpoint); el checkpointer de LangGraph queda como opción nativa de buildGraph. Verificado end-to-end contra Atlas con mocks: retry (1 evento, done), error (status error + evento + rethrow), tool error (realimentado, done), verify (2 eventos [false,true], 2 iters), resume (mismo run_id, transcript releído, final correcto), 0 residuos; typecheck+build limpios. Cierra H2. Siguiente: Núcleo H3 (hidratación completa: repomap + ADRs + conventions).
