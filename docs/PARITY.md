# PARITY — AITL-Harness Python ↔ TypeScript

> **Source of truth:** `docs/parity-contract.json` (identical in `AITL-Harness/docs/` and
> `AITL-Harness-JS/docs/`). This `.md` is the human render of that matrix. If anything
> disagrees, the JSON wins.

## Core rule

Every core capability exists in **both** projects with the same conceptual contract, the
same input/output, the same MongoDB document, an equivalent CLI command, an equivalent MCP
tool, and the same contract tests. `prompt_insights` is the only exception: a
**Python-only** extension.

## Status legend

| Status | Meaning |
|---|---|
| `equivalent` | Implemented in both, contracts + Mongo docs aligned, contract tests pass. |
| `partial` | Implemented in both, but TS is a draft without typecheck/tests and/or the contract rename is missing (Phase 1). |
| `missing` | Absent in one or both projects. |
| `python-only` | An intentionally Python-only extension; never ported to TS. |

## Parity matrix

| Capability | Python | TypeScript | CLI | MCP tool | Mongo | Tests | Status |
|---|---|---|---|---|---|---|---|
| config | `aitl/config.py` | `src/config.ts` | — | — | — | none | partial |
| db.client | `aitl/db/client.py` | `src/db/client.ts` | — | — | factory / COLLECTIONS | smoke | partial |
| db.indexes | `aitl/db/indexes.py` | `src/db/indexes.ts` | `init-db` | — | all + `vector_index` + text | smoke | partial |
| data models | `aitl/memory/schemas.py` | `src/models/*.model.ts` (Mongoose) | — | — | Run/Message/MemoryDoc/ADR/Symbol/Convention/Category/Event | none | partial |
| memory.store | `aitl/memory/store.py` | `src/memory/store.ts` | `search` | `search_memory`,`write_memory` | memory, messages, events | none | partial |
| memory.classifier | `aitl/memory/classifier.py` | `src/memory/classifier.ts` | — | — | categories | none | partial |
| memory.synthesizer | `aitl/memory/synthesizer.py` | `src/memory/synthesizer.ts` | `synthesize` | — | memory(synthesis), events | none | partial |
| providers.base (ProviderPort + FallbackProvider) | `aitl/providers/base.py` | `src/providers/base.ts` | `run --model auto` · `models` | — | — | smoke | partial |
| providers.openai (OpenRouter) | `aitl/providers/openai.py` | `src/providers/openai.ts` | `run --model openrouter` | — | — | smoke | partial |
| providers.anthropic (first-party direct, ADR-0044) | `aitl/providers/anthropic.py` | `src/providers/anthropic.ts` | `run --model anthropic` | — | — | smoke | partial |
| providers.lmstudio (local, via `openai.ts`) | — | `src/providers/openai.ts` | `run --model lmstudio` | — | — | none | partial |
| providers.openai-compat (generic, via `openai.ts`) | — | `src/providers/openai.ts` | `run --model openai-compat` | — | — | none | partial |
| orchestration.graph (loop) | `aitl/orchestration/graph.py` | `src/orchestration/graph.ts` | `run` | — | runs, messages, events | none | partial |
| orchestration.checkpointer | `aitl/orchestration/checkpointer.py` | `src/orchestration/checkpointer.ts` | — | — | checkpoints | none | partial |
| context.manager | `aitl/context/manager.py` | `src/context/manager.ts` | — | — | events(compaction) | none | partial |
| tools (base/fs/shell) | `aitl/tools/*.py` | `src/tools/*.ts` | — | — | — | none | partial |
| hooks.gates | `aitl/hooks/gates.py` | `src/hooks/gates.ts` | — | — | events(gate) | none | partial |
| ingest (embedder/markdown/transcripts) | `aitl/ingest/*.py` | `src/ingest/*.ts` | `ingest` | `ingest_path` | memory, messages | none | partial |
| repomap (parser/ranker/store) | `aitl/repomap/*.py` | `src/repomap/*.ts` | `repomap` | `get_repomap` | symbols | none | partial |
| decisions.adr | `aitl/decisions/adr.py` | `src/decisions/adr.ts` | `adr-sync` | `list_decisions`,`record_decision` | decisions | none | partial |
| conventions.loader | `aitl/conventions/loader.py` | `src/conventions/loader.ts` | — | — | conventions | none | partial |
| adapters (agents_md/cursor/…) | `aitl/adapters/*.py` | `src/adapters/*.ts` | `export` | — | conventions, decisions | none | partial |
| eval.runner | `aitl/eval/runner.py` | `src/eval/runner.ts` | `eval` | — | MetricRecord | none | partial |
| mcpserver | `aitl/mcpserver/server.py` | `src/mcpserver/server.ts` | `mcp` | (all tools) | all (read) | none | partial |
| cli | `aitl/cli.py` | `src/cli.ts` | (all) | — | — | none | partial |
| prompt_insights ✅ | `aitl/prompt_insights/*.py` | — (python-only) | `prompt-insights …` | — | `prompt_*` (5 collections) | none | **python-only (implemented)** |

## Data-layer note (TypeScript)

The TS port has **completed its data-layer migration to Mongoose** (ADR-0036). Persisted
document **shape, validation and types** are now owned by the Mongoose models in
`src/models/*.model.ts` — this replaces the earlier raw `mongodb` driver + Zod document
schemas (`src/memory/schemas.ts`). Documents remain byte-compatible with the pre-migration
data, so parity of persisted fields with the Python side (pydantic) is preserved.

Note that `src/contracts.ts` still uses Zod to type the model-agnostic **ports and value
types** (`ProviderPort`, `ToolPort`, `MemoryPort`, `LoopStrategy`, `ToolCall`, `GateResult`,
`MetricRecord`, …); the migration changed the storage layer, not those contracts.

## Implementation progress

- **Phase 1 (contracts)** ✅ — `aitl/contracts.py` + `src/contracts.ts` mirrored: ports
  (`ProviderPort/ToolPort/MemoryPort/LoopStrategy`), value types (`ToolCall/GateResult/
  MetricRecord/ProviderCapabilities`) and canonical aliases (`DecisionDoc=ADR`,
  `SymbolDoc=Symbol`, `LoopEvent=Event`).
- **Phase 2 (ProviderPort)** ✅ — `count_tokens()` + `capabilities()` in the base and in
  every provider of both projects.
- **Phases 3–4 (providers)** ✅ plumbing — the model backend resolves behind the port. At the
  time, the primary provider was OpenRouter (OpenAI-compatible gateway) with Gemini/OpenAI/
  Anthropic as legacy paths. *Amended by ADR-0044 (2026-07-02):* the TS side now has four
  first-class raw backends — `anthropic` (direct SDK, `src/providers/anthropic.ts`) plus
  `openrouter`/`lmstudio`/`openai-compat` over `src/providers/openai.ts` — chained by a
  `FallbackProvider` (`--model auto`); the legacy `gemini.ts`/`antigravity.ts` provider files
  no longer exist in TS. Pending: contract tests with fakes + verification against the
  real API.
- **Phase 7 (module parity)** ✅ — completed the TS modules that were missing
  (`repomap/store`, `decisions/adr`, `conventions/loader`, `adapters/*`, `eval/runner`,
  `mcpserver/server`, `cli`, `scripts/initDb`, `index`).
- **Data-layer migration (ADR-0036)** ✅ — the TS persisted schemas moved from Zod + raw
  driver to Mongoose models under `src/models/`. Same srv connection, no shards; documents
  byte-compatible with prior data.
- **Phase 9 (prompt_insights, Python-only)** ✅ — `aitl/prompt_insights/{schemas,parser,
  store,runner,cli}.py`; the `aitl prompt-insights {analyze,history,apply}` sub-command; 5
  dedicated collections (they do not touch the shared `COLLECTIONS` list → parity intact);
  non-destructive.
- **Antigravity** (Phase 5): decision = **host/orchestrator (IDE)** → modeled as a
  `HostAdapter`; `gemini-antigravity` by composition. Not implemented yet.
- Typecheck TS: `npx tsc --noEmit` → **green (exit 0)**. CLI TS: `aitl --help` **OK**.

## What must stay identical (persisted fields)

MongoDB documents must have **the same fields** in both projects so they read and write the
same database. The persisted shape is defined by pydantic (Python) and, on the TypeScript
side, by the Mongoose models (`src/models/*.model.ts`, ADR-0036). The model-agnostic ports
and value types (`ProviderPort`, `ToolPort`, `MemoryPort`, `LoopStrategy`, `ToolCall`,
`GateResult`, `MetricRecord`) remain fixed by Phase 1's contracts.
