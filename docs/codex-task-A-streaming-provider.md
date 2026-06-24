# Codex Task A — Streaming en el ProviderPort

> **ADR:** [ADR-0005] §1. **Fase:** A del plan (`docs/TUI-IMPLEMENTATION-PLAN.md`).
> **Independiente de Task B** (archivos disjuntos): puede correr en paralelo.

## Objetivo
Añadir streaming **opcional** al `ProviderPort` sin romper el contrato existente.
`chat()` sigue siendo el contrato de referencia; `chatStream()` es aditivo y opcional.

## Archivos EN alcance
- `src/providers/base.ts` — definir el delta y extender la interfaz `Provider`.
- `src/contracts.ts` — reflejar `chatStream?` en `ProviderPort`.
- `src/providers/gemini.ts`, `src/providers/openai.ts`, `src/providers/anthropic.ts`
  — implementar `chatStream`.
- `src/providers/stream.test.ts` (nuevo) — tests con fakes (sin red).

## Archivos que NO se tocan
`src/orchestration/graph.ts` (es de Task B), `src/cli.ts`, `docs/parity-contract.json`,
cualquier schema en `src/memory/`. No cambiar la firma ni el comportamiento de `chat()`.

## Interfaz a añadir (en `src/providers/base.ts`)
```ts
export type StreamDelta =
  | { type: "text"; text: string }          // fragmento incremental de texto del asistente
  | { type: "done"; turn: ChatTurn };       // turno resuelto (text completo + tool_calls + usage + stop_reason)

export interface Provider {
  // ...existente...
  /** Streaming opcional. Si no se implementa, los llamadores caen a chat(). */
  chatStream?(messages: Record<string, unknown>[], opts?: ChatOpts): AsyncIterable<StreamDelta>;
}
```
Reflejar la misma firma opcional en `ProviderPort` (`src/contracts.ts`).

## Notas de implementación por provider
Normalizar SIEMPRE al mismo `ChatTurn` que ya produce `chat()`; el `done` final debe
ser idéntico en forma a lo que `chat()` devolvería para esa misma petición.
- **OpenAI**: `chat.completions.create({ ..., stream: true, stream_options:{ include_usage:true } })`.
  Emitir `delta.choices[0].delta.content` como `{type:"text"}`. Acumular `delta.tool_calls`
  por `index` (nombre + `arguments` parciales → `JSON.parse` al cerrar). `usage` llega en
  el último chunk.
- **Gemini** (`@google/genai`): `ai.models.generateContentStream({...})`. Emitir
  `chunk.text`. `functionCalls` y `usageMetadata` en el chunk final.
- **Anthropic**: `client.messages.stream({...})`; `content_block_delta`/`text_delta` →
  texto; `tool_use` vía `input_json_delta`; turno final con `.finalMessage()`.

## Criterios de aceptación
1. `npx tsc --noEmit` → exit 0.
2. `node --test` (incl. `stream.test.ts`) → verde. Tests usan un provider/SDK falso:
   verifican que la concatenación de los `{type:"text"}` == `turn.text` del `done`, y que
   `tool_calls`/`usage`/`stop_reason` del `done` igualan los de un `chat()` equivalente.
3. Un provider sin `chatStream` sigue compilando y funcionando (es opcional).
4. `aitl run "..."` (ruta batch) se comporta igual que antes (no usa `chatStream`).

## Fuera de alcance
TUI, observador del loop, wiring de `chatStream` dentro de `runAgent` (eso es C/B).

[ADR-0005]: adr/0005-streaming-in-provider-port.md
