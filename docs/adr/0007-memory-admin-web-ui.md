# ADR-0007 — Memory-admin web UI over an HTTP projection of MemoryStore

- **Status:** Accepted
- **Date:** 2026-06-23

## Context
We want a React UI to administer durable memories (browse, search, create, edit,
delete) that the harness can launch itself. The MCP server (`src/mcpserver/server.ts`)
is **stdio-only** — it serves Claude Code, not a browser — so a web UI needs its own
transport. We must not introduce a second source of truth or a divergent write path:
memories created in the UI have to be classified + embedded exactly like
`write_memory`.

## Decision
Expose a **dependency-free `node:http` API** (`src/server/api.ts`) that is a thin REST
projection of `MemoryStore` (the same gateway the CLI and MCP use). Writes reuse the
`write_memory` contract (classify → embed → upsert), so UI- and MCP-created docs are
identical. New read/delete helpers (`getMemory`, `listMemory`, `deleteMemory`,
`listProjects`) are added to `MemoryStore` rather than touching the driver elsewhere.

The frontend is a **Vite + React SPA** under `web/` (separate from the published CLI;
its deps — `vite`, `react`, `@vitejs/plugin-react` — are **devDependencies** so
`npm i -g` stays lean). `aitl ui` launches **both processes together**: the API in-
process and the Vite dev server as a child, with the SPA reaching the API through
Vite's `/api` proxy. Ctrl-C tears both down.

## Consequences
- A browsable/editable view of the memory bank, launched with one command.
- Single write path → no drift between UI, MCP, and CLI memory writes.
- Two dev processes (API + Vite); acceptable for a dev/admin tool and chosen
  deliberately over a single-bundle build for iteration speed.
- Requires esbuild (Vite); the platform binary ships prebuilt, so the pnpm
  ignored-build warning for `esbuild` does not block the dev server.
- Parity-neutral: TS-only presentation; not mirrored in Python, not in the parity
  contract. Related to the terminal TUI ([ADR-0003]) but a distinct surface (browser).

[ADR-0003]: 0003-interactive-tui-live-agent-chat.md
