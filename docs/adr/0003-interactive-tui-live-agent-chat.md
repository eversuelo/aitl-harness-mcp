# ADR-0003 — Interactive TUI ("live agent chat") as a first-class CLI surface

- **Status:** Accepted
- **Date:** 2026-06-23

## Context
The CLI (`src/cli.ts`) is today a set of ten "fire-and-forget" commands: each opens
Mongo, does one unit of work, prints a result, and closes the client. There is no
interactive surface. For a thesis about **Loop + Harness Engineering**, the agent loop
itself (iterations, tool calls, permission gates, context compaction, token budget) is
the central object of study, yet `aitl run` only prints the final text after the loop
finishes — the loop is invisible while it runs.

We considered three shapes for an interactive surface: (a) a live agent **chat** that
streams the loop as it executes, (b) a read-only **browser** over persisted memory /
runs / repomap / decisions, and (c) a combined dashboard. The decision driver is
pedagogical: the artifact should make the loop *observable*.

## Decision
Add an interactive **live agent chat** as a first-class CLI surface (working name
`aitl chat`). It runs the model-agnostic loop and renders each step in real time:
the assistant's streamed text, every requested tool call and its gate decision, tool
results, and loop bookkeeping events (`loop_iter`, `tool_call`, `compaction`). The
read-only memory/run browser (option b) is deferred; the combined dashboard (option c)
is explicitly out of scope for now.

The chat surface is **additive**: it reuses `runAgent` and the existing `ProviderPort`
/ `ToolRegistry` / `MemoryStore`; it does not fork the loop. Everything the TUI shows
is already persisted to Mongo, so the TUI is a view, not a second source of truth.

## Consequences
- The loop becomes observable, which directly serves the thesis narrative.
- It forces an observability seam into the loop (events/callbacks) and streaming into
  the provider — see [ADR-0005].
- A new interactive entry point coexists with the batch commands; `aitl run` stays as
  the non-interactive/scriptable path.
- Added maintenance surface (an interactive UI) that must be kept in parity-neutral
  territory: the TUI is TypeScript-only ergonomics, not a new persisted contract, so it
  does **not** change `docs/parity-contract.json`.
