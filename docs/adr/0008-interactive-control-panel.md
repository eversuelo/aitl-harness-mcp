# ADR-0008 — Interactive control panel as a zero-dependency readline supervisor

- **Status:** Accepted
- **Date:** 2026-06-23

## Context
Starting/stopping the long-running surfaces (the MCP server, the memory-admin UI) and
running one-off commands meant remembering separate `aitl` invocations. We wanted a
single interactive entry point (`aitl --interactive` / `aitl -i`) that runs in a loop:
navigate options or type a command, supervise services, see their status.

Two designs were on the table: a zero-dependency `node:readline` panel, or an Ink-based
live dashboard ([ADR-0004] reserved Ink for the agent-chat TUI). The deciding factors
were the global-install constraint ([ADR-0006]) and dependency weight: Ink would require
promoting `react`+`ink` to runtime `dependencies`, fattening `npm i -g`.

## Decision
Build a **zero-dependency readline supervisor** at `src/interactive/menu.ts`:
- ↑/↓ + Enter navigation, `1-9` shortcuts, `:` for a command line, `q`/Ctrl-C to quit.
- Long-running services (`mcp`, `ui`) run as **tracked child processes** with a live
  ●/○ status and a small rolling log panel; one-shot commands run attached (inherit
  stdio) and return to the menu.
- Every action is dispatched by **re-spawning this same CLI** as a child
  (`process.execPath` + `execArgv` replay, with a `tsx` loader shim in dev), so the
  panel reuses the exact command surface in `cli.ts` with no duplicated logic.
- Bare `aitl`, `aitl -i`, and `aitl interactive` all open the panel; a non-TTY stdin
  prints a hint and exits.
- Windows service shutdown uses `taskkill /T` to also stop the UI's Vite grandchild.

Ink remains the choice for the richer live agent-chat TUI ([ADR-0003]/[ADR-0004]).

## Consequences
- One launchpad for the whole harness; works after `npm i -g` (no new deps).
- Reusing the CLI by re-spawning avoids re-entrancy bugs (Mongo client, commander) and
  keeps a single command definition.
- Trade-off accepted: a readline panel is less rich than an Ink dashboard (logs are a
  rolling panel, not independently scrollable panes).
- Parity-neutral: TS-only ergonomics; not in the parity contract.

[ADR-0003]: 0003-interactive-tui-live-agent-chat.md
[ADR-0004]: 0004-ink-as-tui-rendering-library.md
[ADR-0006]: 0006-user-level-config-profile.md
