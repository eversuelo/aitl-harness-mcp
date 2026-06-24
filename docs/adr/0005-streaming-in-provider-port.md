# ADR-0005 — Extend the ProviderPort with streaming before building the TUI

- **Status:** Accepted
- **Date:** 2026-06-23

## Context
The `ProviderPort` ([src/providers/base.ts], `src/contracts.ts`) exposes `complete()`
and `chat()`. `chat()` resolves a single `ChatTurn` only **after** the model has
finished the whole turn — there is no incremental output. The loop (`runAgent`) mirrors
this: it `await`s the full turn, persists it, then continues. There is also no way for
an external observer to watch the loop; it only writes to Mongo.

A "live agent chat" ([ADR-0003]) needs two things the current core cannot provide:
(1) **token-level streaming** of assistant text, and (2) **loop-level events** the UI
can subscribe to (turn started, tool requested, gate decision, tool result, compaction,
turn finished). All four providers already declare `capabilities().streaming === true`,
so the underlying SDKs support it — only the port and loop need the seam.

We decided to build this seam **first**, before the TUI, so the TUI consumes real
streaming data from day one rather than being retrofitted.

## Decision
1. Add an optional `chatStream(messages, opts)` to the `ProviderPort` that yields
   incremental deltas (`text` chunks, then resolved `tool_calls` + `usage` +
   `stop_reason`). Providers without streaming may leave it undefined; callers fall back
   to `chat()`. The normalized streaming shape is defined once next to `ChatTurn`.
2. Give `runAgent` an optional **observer** (an `onEvent` callback / async event
   stream) that emits the same `LoopEvent` types already persisted to Mongo, plus
   text deltas. Persistence is unchanged; the observer is an additional, non-breaking
   tap. When no observer is passed, behaviour is byte-for-byte identical to today.

`chat()` remains the contract of record; `chatStream()` is additive and optional, so
the parity contract and all existing callers are unaffected.

## Consequences
- The TUI ([ADR-0003], [ADR-0004]) is fed by real streaming + structured loop events.
- `complete()`/`chat()` keep working unchanged; batch `aitl run` is untouched.
- Streaming is implemented per provider incrementally (Gemini → OpenAI → Anthropic),
  matching the existing rollout order; a provider lacking it degrades to `chat()`.
- Slightly larger `ProviderPort`; mitigated by making `chatStream()` optional and
  keeping the normalized delta type small.
- The observer seam is reusable beyond the TUI (e.g. logging, eval traces, the MCP
  server).
