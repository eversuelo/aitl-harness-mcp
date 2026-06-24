# Codex Task B — Observador del loop en `runAgent`

> **ADR:** [ADR-0005] §2. **Fase:** B del plan (`docs/TUI-IMPLEMENTATION-PLAN.md`).
> **Independiente de Task A** (archivos disjuntos): puede correr en paralelo.

## Objetivo
Dar al loop una costura de observabilidad **aditiva y no intrusiva**: un callback
opcional que emite los mismos eventos que ya se persisten en Mongo, para que un
consumidor externo (el futuro TUI, logging, trazas de eval) pueda seguir el loop en
vivo. Sin observador, el comportamiento es idéntico al actual.

## Archivos EN alcance
- `src/orchestration/graph.ts` — añadir el observador a `runAgent`.
- `src/orchestration/observer.test.ts` (nuevo) — tests con fakes.

## Archivos que NO se tocan
`src/providers/*` (es de Task A), `src/contracts.ts`, `src/cli.ts`,
`docs/parity-contract.json`, schemas de `src/memory/`. **No** cambiar qué se persiste
ni el shape de los documentos `runs`/`messages`/`events`.

## Interfaz a añadir (en `src/orchestration/graph.ts`)
```ts
export type LoopObserverEvent =
  | { type: "turn_start"; iter: number }
  | { type: "assistant"; iter: number; text: string; toolCalls: { name: string }[] }
  | { type: "tool_call"; iter: number; name: string; allowed: boolean; result: string }
  | { type: "compaction"; iter: number }
  | { type: "turn_end"; iter: number }
  | { type: "done"; runId: string; iters: number; finalText: string };

export interface RunAgentOpts {
  // ...existente...
  onEvent?: (ev: LoopObserverEvent) => void;   // opcional; sin él, sin cambios
}
```
Invocar `opts.onEvent?.(...)` en los puntos donde el loop **ya** registra a Mongo
(`logEvent` de `loop_iter`/`tool_call`/`compaction`) más `turn_start`/`turn_end`/`done`.
La emisión es best-effort y **nunca** debe lanzar ni alterar el flujo: envolver en
try/catch y seguir. El gate ya devuelve `[allowed, reason]` vía `registry.call`; exponer
`allowed`/`result` en el evento `tool_call` (puede requerir leer el resultado que ya se
calcula, sin añadir llamadas extra).

## Criterios de aceptación
1. `npx tsc --noEmit` → exit 0.
2. `node --test` (incl. `observer.test.ts`) → verde. El test corre `runAgent` con un
   provider fake (uno que pide una tool y luego termina) + `MemoryStore` fake/en
   memoria, y verifica el **orden** de eventos: `turn_start → assistant → tool_call →
   turn_end → ... → done`.
3. Test que confirma que `runAgent` **sin** `onEvent` produce exactamente los mismos
   writes a Mongo que antes (mismo número y tipo de `events`).
4. Un `onEvent` que lanza una excepción no rompe el run (best-effort).

## Notas
- Reutiliza los tipos `LoopEvent` existentes para la persistencia; `LoopObserverEvent`
  es solo la vista del observador (no se persiste, no toca el contrato de paridad).
- Mantén el observador desacoplado de cualquier detalle de UI/Ink.

## Fuera de alcance
Streaming de texto a nivel de provider (Task A) y el render del TUI (Fase C). Si Task A
ya aportó deltas de texto, su wiring al observador se hace en la Fase C, no aquí.

[ADR-0005]: adr/0005-streaming-in-provider-port.md
