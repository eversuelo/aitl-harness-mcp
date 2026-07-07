# Plan de implementación — CLI interactivo + TUI (`aitl chat`)

> Deriva de [ADR-0003] (live agent chat), [ADR-0004] (Ink) y [ADR-0005] (streaming
> primero). Principio rector: **todo es aditivo** — `chat()`, `runAgent` no-observado,
> y los 10 comandos batch quedan byte-for-byte iguales; el contrato de paridad
> (`docs/parity-contract.json`) **no** cambia.

## Estado de partida

- Loop real y funcional en `src/orchestration/graph.ts` (`runAgent`), persiste
  `runs`/`messages`/`events` en Mongo.
- `ProviderPort` con `complete()` + `chat()` (sin streaming). Los 4 providers ya
  declaran `capabilities().streaming === true`.
- CLI commander con 10 comandos, todos "fire-and-forget". Sin superficie interactiva.

## Fases

### Fase A — Streaming en el ProviderPort  *(ADR-0005 §1)*
- Definir un delta normalizado junto a `ChatTurn` en `src/providers/base.ts`:
  `StreamDelta = {type:"text", text} | {type:"done", turn: ChatTurn}`.
- Añadir `chatStream?(messages, opts): AsyncIterable<StreamDelta>` **opcional** al
  `Provider` (base) y al `ProviderPort` (`src/contracts.ts`).
- Implementar en Gemini → OpenAI → Anthropic (orden de rollout existente). Cada uno
  acumula el texto y resuelve `tool_calls`/`usage`/`stop_reason` en el `done`.
- Fallback: si un provider no define `chatStream`, los llamadores usan `chat()`.

### Fase B — Observador del loop  *(ADR-0005 §2)*
- Añadir `onEvent?(ev): void` (y opcionalmente deltas de texto) a `RunAgentOpts` en
  `runAgent`. Emite los mismos `LoopEvent` que ya se persisten (`loop_iter`,
  `tool_call`, `compaction`) + inicio/fin de turno y la decisión del gate.
- Sin observador → comportamiento idéntico al actual. La persistencia no se toca.

### Fase C — Esqueleto del TUI con Ink  *(ADR-0003 + ADR-0004)*
- `tsconfig.json`: `jsx: react-jsx`. Añadir deps `ink`, `react`.
- `src/tui/` con componentes (Transcript, ToolCallPanel, StatusBar, InputBox).
- Comando `aitl chat --project P [--model m]` que monta el loop con observador y
  `chatStream`, y renderiza el estado del loop en vivo.

### Fase D — Pulido y verificación
- Render headless con `ink-testing-library`; fakes de provider para Fases A/B.
- Manejo de Ctrl-C / cancelación; scroll del transcript; resumen de tokens.

## Orden de ejecución

Fases **A y B son independientes** (archivos disjuntos) → paralelizables (ver tareas
para Codex abajo). **C** depende de A+B. **D** cierra.

```
A (providers) ─┐
               ├─► C (TUI) ─► D (pulido)
B (loop obs.) ─┘
```

## Tareas para Codex (independientes, paralelizables)

Dos briefs autocontenidos y sin solapamiento de archivos, listos para ejecutar en
paralelo:

- [`codex-task-A-streaming-provider.md`](codex-task-A-streaming-provider.md) — Fase A.
- [`codex-task-B-loop-observer.md`](codex-task-B-loop-observer.md) — Fase B.

[ADR-0003]: adr/0003-interactive-tui-live-agent-chat.md
[ADR-0004]: adr/0004-ink-as-tui-rendering-library.md
[ADR-0005]: adr/0005-streaming-in-provider-port.md
