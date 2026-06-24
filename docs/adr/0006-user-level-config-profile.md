# ADR-0006 — User-level config profile with export/import (for global install)

- **Status:** Accepted
- **Date:** 2026-06-23

## Context
The harness is meant to be installed globally (`npm i -g`). A global CLI has no
project-local `.env` in its working directory, so the existing config path
(`src/config.ts` reading `process.env` via dotenv) leaves a globally-installed `aitl`
with nothing but built-in defaults. Users also need a way to move their configuration
(Mongo URI, model selection, API keys) between machines as a portable profile.

## Decision
Add a **user-level config file** at `~/.aitl/config.json` (overridable via `AITL_HOME`)
holding ENV-style keys (same names as `.env.example`). Resolution precedence, highest
wins:

    process.env  >  ~/.aitl/config.json  >  zod defaults

An **empty** env var (e.g. a blank `GEMINI_API_KEY=` in a dev `.env`) is treated as
*unset* for layering, so it never shadows a value stored in the profile. File I/O lives
in `src/config/store.ts` (which must not import `config.ts` — it is consumed by it).

CLI surface: `aitl config {path,show,export,import,set,unset}`. `export`/`show` **mask
secrets by default** (`GEMINI/OPENAI/ANTHROPIC/VOYAGE` keys and Mongo credentials);
`--secrets` opts into plaintext for genuine transfer.

## Consequences
- A globally-installed `aitl` is configurable without a project `.env`.
- Config is portable: `export --secrets > profile.json` → `import` on another machine.
- Safe-by-default sharing: copy/pasting `config show` won't leak keys.
- One more precedence layer to reason about; documented here and in `.env.example`.
- Parity-neutral: TS-only ergonomics; does not change `docs/parity-contract.json`.
