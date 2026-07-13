# ADR-0065 — Interrupción con ESC: aborto limpio y resumible del turno del agente

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/orchestration, src/repl, src/models

## Context

En el chat REPL la única forma de detener un turno era Ctrl+C, que mata el REPL completo (ADR-0045). Con modelos locales lentos y volcados largos (p. ej. un modelo imprimiendo un archivo entero), el usuario necesita cancelar el turno en curso sin perder la sesión ni el run. El loop runAgent no tenía ningún punto de aborto y los providers no aceptan AbortSignal.

## Decision

Aborto cooperativo por AbortSignal en tres capas. (1) consumeStream acepta signal y compite cada gen.next() contra el abort: lanza StreamInterrupted (clase propia, NUNCA transitoria — withRetry no debe reintentar un turno interrumpido) y cierra el stream con gen.return() best-effort. (2) RunAgentOpts.signal + stop_reason "interrupted" con tres checkpoints: tope de iteración, media generación (el turno en vuelo se descarta — nada suyo se persistió), y entre tool calls (las llamadas pendientes no se ejecutan pero reciben resultado sintético "[interrupted by user]" para que el transcript quede coherente y resumible via resume); cada checkpoint emite evento "interrupt" (nuevo en EVENT_TYPES). El run termina status done + stop_reason interrupted, no error. (3) src/repl/escape.ts: listener de stdin en raw mode SOLO durante el turno (el REPL ya suelta stdin: rl.close() + setRawMode(false)); un ESC desnudo (un solo byte 0x1b, nunca secuencias CSI de flechas/F-keys) aborta el turno; 0x03 se re-emite como SIGINT para que ^C siga matando el REPL (preserva ADR-0045). Tras interrumpir, el runId se conserva: el siguiente mensaje continúa el mismo run.

## Consequences

- ESC cancela el turno sin perder sesión ni run; ^C conserva su semántica de kill total.
- "interrupted" es un stop_reason nuevo distinguible en métricas: jamás debe contarse como fallo del agente (es intervención humana; relacionable con supervision_minutes de H11).
- El aborto es cooperativo: con provider no-streaming (chat() sin onDelta) el corte llega al siguiente checkpoint, no a media llamada HTTP.
- gen.return() sobre un stream realmente colgado no puede forzar el cierre (misma limitación best-effort que el idle deadline de ADR-0045).
- 6 tests nuevos (393 total).
