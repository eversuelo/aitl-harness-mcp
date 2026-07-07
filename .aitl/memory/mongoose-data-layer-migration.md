---
name: mongoose-data-layer-migration
description: >-
  Mongoose migration (ADR-0036) + branch-aware repo map (ADR-0037) on branch
  feat/mongoose-migration — conventions, gotchas, follow-ups.
type: project
category: decision
tags:
  - mongoose
  - migration
  - data-layer
  - repomap
  - adr-0036
  - adr-0037
version: 1
updated_at: 2026-07-01T16:33:53.852Z
branch: feat/mongoose-migration
---
Data layer migrated from the raw `mongodb` driver + Zod to **Mongoose** (ADR-0036) on branch `feat/mongoose-migration` (2026-07-01; 10 commits, NOT yet merged/pushed to master). Models live in `src/models/*.model.ts` (18 files → 20 collections). Zod is kept ONLY for MCP tool params (SDK requirement), `config` settings, and the `Role` value-object — everything else is Mongoose.

Conventions / gotchas for future work:
- `src/db/mongoose.ts`: `connectMongoose`/`ensureMongoose`/`disconnectMongoose`. Call `await ensureMongoose()` FIRST in every store method. `BASE_SCHEMA_OPTS` = { versionKey:false, timestamps:false, minimize:false } so docs stay byte-compatible with pre-migration data (no `__v`, app-managed created_at/updated_at, empty `{}` preserved). Reads use `.lean()`.
- Connection = the SAME Atlas `mongodb+srv://` seedlist as before (no shard hosts, no directConnection); primary→fallback preserved. The raw driver `getDb()` is RETAINED as a coexistence layer for the hexagonal `graph/source` port + index bootstrap (`db/indexes.ts`) → two connection pools for now (optional future unification: back `getDb()` with `mongoose.connection`).
- `make*` builders do `new Model(v)` → `validateSync()` → `toObject()` → `delete _id`. `validateSync()` is DEPRECATED in Mongoose 9 (removed in 10) — convert to async `validate()` (or move validation to write time) when bumping to Mongoose 10.
- `runs`: `_id:{type:String}` (app UUID, not ObjectId) + **`strict:false`** — required, else dynamic telemetry written via `$set` (host_meta, iters, gate_denials, tool_calls, artifacts, roles, spec) is silently dropped (this was a caught bug).
- `agents`+`skills` = one schema, two models via `.clone()` (`definition.model.ts`); roles are `agents` docs with `metadata.kind==='role'` (RoleStore). `history.model.ts` = two models (`decisions_history`/`memory_history`).
- `$vectorSearch` and the vector→text→recency cascade run via `Model.aggregate` (MemoryStore); the `vector_index` def in `db/indexes.ts` is unchanged.

Repo map is now branch-aware (ADR-0037): a `branch` field on the Symbol model, `walkSources` respects `.gitignore` via the `ignore` lib (excludes `dist/`), stores relative paths, keeps a constant footprint (one branch snapshot), and `render` warns on a branch mismatch. NOTE: the LIVE stored map is still an old dist-polluted index — run `aitl index-repo --root . --project aitl-js` to refresh it.

Verified green at every phase: typecheck 0, 51/51 tests, `aitl search`/`hydrate`/`role list`=5/`check-db`/`run-show`; 35 ADRs + 5 roles + 2 skills + prompts read intact (no `__v`, embeddings stripped). Next per roadmap: T1 (benchmark runner), which is the actual thesis gap.
