---
name: tui-stdin-steal-chat-fixes
description: >-
  Bug "hay que pulsar dos veces cada tecla" en aitl chat lanzado desde el TUI:
  el menú padre dejaba stdin en flowing mode y robaba ~la mitad de los bytes del
  hijo. Fix = pausar stdin en suspend(); + spinner idempotente, teardown en
  SIGINT y stream idle timeout.
type: reference
category: bug
tags:
  - bug
  - tui
  - chat
  - stdin
  - readline
  - streaming
  - debugging
  - 'component:src/interactive'
  - 'component:src/repl'
  - 'component:src/orchestration'
version: 1
updated_at: 2026-07-06T04:13:09.889Z
branch: master
---
Debugging live 2026-07-05: `aitl -i` → Chat se "trababa" y había que **pulsar cada tecla dos veces**; `/exit` llegaba mutilado y la sesión parecía colgada.

**Reproducción determinista** (pty vía `script -qec`, stub OpenAI-compat en :1234 supliendo a LM Studio): tecleando lento "hola como estas" el REPL hijo recibía `hocai` — la mitad de los caracteres, alternados.

**Causa raíz** (src/interactive/menu.ts): `runInteractive` hace `stdin.resume()` + raw mode al arrancar. `suspend()` quitaba el listener de keypress y bajaba raw mode, pero **no pausaba stdin**: un stream en flowing mode sigue haciendo read(2) del fd aunque no tenga listeners 'data', descartando los bytes. El chat corre como hijo con `stdio:"inherit"` (mismo fd de TTY) → padre e hijo compiten byte a byte por cada keystroke (~50/50).

**Fixes aplicados**:
1. `suspend()` ahora hace `stdin.pause()` antes de correr la acción y `stdin.resume()` al restaurar el menú; los "Press Enter to return" hacen `stdin.resume()` explícito, y `commandMode` re-pausa tras cerrar su readline antes de spawnear el hijo (src/interactive/menu.ts).
2. Spinner del chat idempotente: `stopSpin()` se llamaba 2 veces (primer delta + fin del run) y cada llamada escribía `\r`+15 espacios, borrando los primeros ~15 chars de la respuesta streameada (síntoma visto: "respuesta-stub-3" se mostraba como "               3"). Ahora limpia la línea solo una vez (src/repl/chat.ts).
3. Ctrl+C en el chat hacía `process.exit(130)` a pelo → huérfanos los procesos hijos de servidores MCP (`--mcp`) y conexiones DB abiertas. Ahora cierra mcpMount + closeClient con backstop de 2s antes de salir (src/repl/chat.ts).
4. Stream idle timeout (src/orchestration/stream.ts): `consumeStream` no tenía deadline — un server local que acepta la request y se cuelga sin cerrar el SSE dejaba el spinner girando para siempre (withRetry nunca dispara porque nada lanza). Ahora 180s de silencio máximo entre deltas (configurable `AITL_STREAM_IDLE_MS`, ≤0 lo desactiva); el error contiene "timeout" → transitorio → withRetry replays el turno; `gen.return()` cierra el HTTP stream.
5. Los `spawn` del menú (startService/runAttached/commandMode) no escuchaban `error` → un ENOENT tumbaba el TUI entero con excepción no capturada. Añadidos handlers.

Verificado: typecheck limpio, 104/104 tests, build ok; pty E2E: teclas llegan íntegras, texto streameado íntegro, `/exit`→menú→`q`→"Bye." limpio; resume multi-turno confirmado (turno 2 llega con transcript recuperado). Relacionado: [[openai-v4-premature-close-lmstudio]] (fixes previos del mismo REPL).
