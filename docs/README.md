# Documentation

Reading index for exploring AITL-Harness-JS.

## Recommended reading order

1. [../README.md](../README.md) — install, commands and the overall map.
2. [ARQUITECTURA.md](ARQUITECTURA.md) — the **canonical architecture document**
   (hexagonal ports, agent loop, harness-v2 cycle, MCP/CLI surfaces, durable store).
3. [MONGODB-ATLAS.md](MONGODB-ATLAS.md) — MongoDB / Atlas Vector Search setup (local and cloud).
4. [RBAC-REGISTRO.md](RBAC-REGISTRO.md) — RBAC model, users, audit and root bootstrap.
5. [adr/README.md](adr/README.md) — Architecture Decision Records.

## ADRs

The **ADR ledger lives in MongoDB** (the `decisions` collection), contiguous
**0001–0072** as of 2026-07-11 (read the live next-free from the collection, not from
docs). Since ADR-0051 the full series is mirrored as markdown under
[adr/](adr/) by `aitl sync --project aitl-js` (two malformed legacy docs,
`0036-mongoose-data-layer` and `0037-branch-aware-repomap`, are skipped by the
mirror; their canonical `0036`/`0037` entries are mirrored normally). ADRs are also
retrievable through the durable store (`aitl adr history`, the `list_decisions` MCP
tool, or the web UI).

## Contracts and parity

| File | Purpose |
|---|---|
| [PARITY.md](PARITY.md) | Human-readable Python ↔ TypeScript parity matrix. |
| [parity-contract.json](parity-contract.json) | Structured capability contract (source of truth). |

## Operations

| File | Purpose |
|---|---|
| [MONGODB-ATLAS.md](MONGODB-ATLAS.md) | MongoDB local and Atlas cloud. |
| [RBAC-REGISTRO.md](RBAC-REGISTRO.md) | RBAC, root registration and user/agent permissions. |
| [token-accounting.md](token-accounting.md) | How tokens are counted in Runs (snapshot vs. cumulative, caching). |

## Archived material

Historical documents live in [attic/](attic/): the English audit-style architecture
review, thesis planning notes and session logs. They are kept for reference only —
the living history is the durable store (decisions, memory, prompt log in Mongo).

## Navigation rule

READMEs point at folders; ADRs explain **why** each decision exists; the files under
`src/*` show **how** it is implemented.
