# ADR-0039 — In-process pre/post tool hooks in the ToolRegistry

- **Status:** Accepted
- **Date:** 2026-07-01

## Context
The only extensibility seam around tool execution was the `PermissionGate` chain —
binary allow/deny, evaluated before the tool runs. There was no way to *transform*
what a tool sees (inject defaults, redact secrets from args) or what it returns
(truncate giant outputs, annotate results) without wrapping every `Tool`
implementation. Mature harnesses expose this as PreToolUse/PostToolUse hooks; the
docstring of `src/tools/base.ts` referenced the pattern but nothing implemented it.

## Decision
`ToolRegistry` gains two in-process hook chains around `tool.run` (both additive):

1. **`addPreHook(h)`** — `(name, args) → void | { args? }`. Runs AFTER gates
   (deterministic policy stays first). May rewrite the args the tool will see; hooks
   chain in registration order, each seeing the previous mutation. A **throwing
   pre-hook aborts the call** (`[tool error] …`, the tool never runs), so pre-hooks
   can act as programmable policy.
2. **`addPostHook(h)`** — `(name, args, result) → void | { result? }`. May transform
   the result fed back to the model. Each post-hook runs in its own try/catch: a
   broken observer is skipped and the tool's output is preserved.

Telemetry: `call()` accepts `opts.onHookEvent`, invoked ONLY when a hook acts
(mutates args/result). `runAgent` wires it to the event log as `tool_pre_hook` /
`tool_post_hook` events, so hook interference is auditable in the same durable
stream as gates and tool calls.

Out of scope (explicitly): externally-configured shell hooks (à la Claude Code
settings). This seam is in-process TypeScript only; a config-driven layer can be
built on top of it later without changing the registry.

## Consequences
- Cross-cutting behaviors (arg redaction, output truncation, budget accounting)
  attach without touching any `Tool` implementation — including MCP-mounted tools.
- `call()` keeps its signature backwards-compatible (the 4th arg is optional);
  existing callers and tests are unaffected.
- Silent observers stay silent in telemetry: only *acting* hooks emit events,
  keeping the event stream signal-dense for thesis metrics.
- A throwing pre-hook is indistinguishable from a tool error in the transcript
  (`[tool error]`); acceptable, since the model's recovery path is identical.
