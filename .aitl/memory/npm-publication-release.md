---
name: npm-publication-release
description: >-
  aitl-mcp packaged + pushed to GitHub (eversuelo/aitl-harness-mcp) as a clean
  squashed release; English docs, LICENSE, docker-compose. Continues
  [[mongoose-data-layer-migration]].
type: project
category: decision
tags:
  - release
  - npm
  - publication
  - docs
  - squash
  - adr-0036
  - adr-0037
version: 1
updated_at: 2026-07-01T17:49:09.536Z
branch: master
---
After the Mongoose migration (ADR-0036) + branch-aware repo map (ADR-0037), the repo was packaged for a public release as npm `aitl-mcp` / GitHub `github.com/eversuelo/aitl-harness-mcp` (renamed from AITL-Harness-JS).

Done: removed cruft (empty `examples/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`); added MIT `LICENSE` + `docker-compose.yml` (`mongodb/mongodb-atlas-local`, required because `$vectorSearch`/`createSearchIndex` need Atlas Search); npm metadata (`repository`/`homepage`/`bugs` → aitl-harness-mcp, `keywords`, `prepublishOnly=verify`); slim publish via `tsconfig.build.json` (excludes `**/*.test.ts` from the build) + `.npmignore` → tarball 187 files / ~256 kB, no test or source-map files. Rewrote `README.md` + `docs/*` to ENGLISH incl. a step-by-step Tutorial and a "Status & roadmap" note that **end-to-end RBAC enforcement is PENDING**. Exported ADR 0036/0037 as `.md`; `docs/adr/README.md` reconciled (0001–0037, 0010–0025/0032–0035 are ledger-only); relocated thesis/session docs to `docs/thesis/`. `CLAUDE.md` lightly updated (ledger→0037), preserving the hand-crafted content.

Verified: typecheck 0, 51/51 tests, `check-db`/`role list`/`search`/`run-show` green. Secret gate CLEAN — scanned all 48 commits: no prod DB credential ever tracked; `.mcp.json.example` is placeholders only.

Git: squashed the entire 48-commit history into ONE commit (`17b8b52`) and force-pushed `master` (full history kept locally in `backup/pre-squash-history`). This was a cosmetic clean-history step, NOT a security fix (history had no secrets).

npm audit: 14 vulns remain (8 moderate / 5 high / 1 critical), ALL in OPTIONAL deps (`@xenova/transformers`→onnx, `@langchain/langgraph`, `uuid` via `@google/genai`); safe `npm audit fix` was a no-op (rest need `--force`/breaking) → left as-is.

Pending: `npm publish` (name `aitl-mcp` is free), end-to-end RBAC enforcement, and T1 (benchmark runner) which remains the thesis's evaluative gap.
