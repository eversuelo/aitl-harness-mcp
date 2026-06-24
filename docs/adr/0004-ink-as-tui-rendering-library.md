# ADR-0004 — Use Ink (React for the terminal) as the TUI rendering library

- **Status:** Accepted
- **Date:** 2026-06-23

## Context
[ADR-0003] commits us to an interactive TUI. We need a rendering layer for it. The
project is ESM-native (`"type": "module"`), Node ≥ 20, TypeScript. Candidates:

- **Ink** — a React renderer for the terminal. Declarative components, flexbox layout
  (Yoga), first-class support for streaming/incremental updates, large ecosystem
  (`ink-text-input`, `ink-spinner`, `ink-table`). ESM-native. Cost: adds `react` +
  `ink` as dependencies and a JSX/TSX build step.
- **blessed / neo-blessed** — lower-level ncurses-style widgets. Powerful but
  imperative, heavier to drive, and effectively unmaintained.
- **Minimal (`readline` + ANSI escapes)** — zero new dependencies, but we would
  hand-roll layout, re-render diffing, and input handling for a UI whose whole point is
  a rich live view of the loop.

## Decision
Use **Ink**. The reactive component model maps cleanly onto "render the loop state as
it changes": loop events become state updates and the view re-renders. TSX is compiled
by the existing `tsc` toolchain (`jsx: react-jsx`). `ink` and `react` are added as
**regular dependencies**; TUI source lives under `src/tui/` and is only imported by the
`aitl chat` command path, so non-TUI consumers of the library never load it.

## Consequences
- Fast path to a polished live view (spinners, panels, scrolling transcript) without
  hand-rolling terminal primitives.
- New dependencies (`react`, `ink`) and a JSX build configuration in `tsconfig.json`.
- TUI components are testable as plain functions of loop state; `ink-testing-library`
  can render them headlessly.
- Parity-neutral: Ink is a TS-only presentation choice and never appears in the
  Python port or the parity contract.
