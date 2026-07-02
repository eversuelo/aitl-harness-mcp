# ADR-0041 — MCP client: mount remote servers as namespaced tools

- **Status:** Accepted
- **Date:** 2026-07-01

## Context
The harness EXPOSES an MCP server (~40 tools for Claude Code/Cursor), but its own
loop could not CONSUME MCP servers: `runAgent` only saw the three built-in tools.
That inverts the ecosystem's value — every capability an MCP server offers
(databases, browsers, APIs) was invisible to `aitl run`, while the thesis design
(ADR-0001) lists "MCP servers" among the edge adapters. The SDK already ships the
client half (`Client`, `StdioClientTransport`); only the mounting seam was missing.

## Decision
1. **Standard manifest.** `src/mcpclient/config.ts` reads the standard `.mcp.json`
   (`{"mcpServers": {name: {command, args?, env?, cwd?}}}`) — the same file Claude
   Code reads, so an already-configured workspace works with zero extra config.
   Missing file → no-op; malformed file → loud error (user mistake).
2. **Namespaced mounting.** `mountMcpTools` spawns each server over stdio (env merged
   over the SDK's safe defaults), lists its tools and registers each one in the
   `ToolRegistry` as **`mcp__<server>__<tool>`**. The remote JSON Schema passes
   through untouched; results flatten to the registry's string convention
   (`isError` → `[tool error] …`). Remote calls carry a per-call timeout.
3. **Approval synergy.** A mounted tool gets `requiresApproval: true` unless the
   server declares `annotations.readOnlyHint` — unknown side effects default to
   requiring a human under `--ask` (ADR-0040).
4. **Lifecycle owned by the CLI.** `aitl run --mcp [path]` mounts before the run and
   closes in `finally`; `runAgent` never owns child processes. Connection results are
   logged as `mcp_connect` events (project-scoped). A server that fails to start or
   times out (15s) is reported and skipped — **the run continues** with whatever
   mounted successfully.

## Consequences
- The loop's tool surface becomes extensible without writing TypeScript: drop a
  server into `.mcp.json` and it is available (and gated, and audited) like any
  built-in tool.
- Self-hosting becomes possible: the harness can mount its own MCP server and give
  the loop durable-memory tools (`mcp__aitl-js__search_memory`, …).
- `InMemoryTransport` keeps the tests hermetic (no child processes).
- Namespacing makes cross-server collisions impossible but produces long tool names;
  acceptable — models handle them and the provenance is explicit.
- stderr of spawned servers is ignored for terminal cleanliness; diagnosis relies on
  connect errors and the `mcp_connect` event payload.
