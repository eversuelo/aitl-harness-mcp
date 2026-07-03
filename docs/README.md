# Documentation

Reading index for exploring AITL-Harness-JS.

## Recommended reading order

1. [../README.md](../README.md) — install, commands and the overall map.
2. [ARQUITECTURA-AITL-JS.md](ARQUITECTURA-AITL-JS.md) — the **canonical TypeScript
   architecture** (hexagonal ports, MCP, CLI, roles, durable store).
3. [MONGODB-ATLAS.md](MONGODB-ATLAS.md) — MongoDB / Atlas Vector Search setup (local and cloud).
4. [RBAC-REGISTRO.md](RBAC-REGISTRO.md) — RBAC model, users, audit and root bootstrap.
5. [adr/README.md](adr/README.md) — Architecture Decision Records.

## ADRs

The **ADR ledger lives in MongoDB** (the `decisions` collection), currently spanning
**0001–0044**. Only a subset is exported as files under [adr/](adr/); the rest are
retrievable through the durable store (`aitl adr history`, the `list_decisions` MCP tool,
or the web UI). Exported files:

| ADR | Topic |
|---|---|
| [0001](adr/0001-record-architecture-decisions.md) | Record architecture decisions in git and Mongo. |
| [0002](adr/0002-mongodb-atlas-vector-search.md) | MongoDB Atlas Vector Search as the durable store. |
| [0003](adr/0003-interactive-tui-live-agent-chat.md) | Interactive TUI live agent chat. |
| [0004](adr/0004-ink-as-tui-rendering-library.md) | Ink as the TUI rendering library. |
| [0005](adr/0005-streaming-in-provider-port.md) | Streaming in the provider port. |
| [0006](adr/0006-user-level-config-profile.md) | User-level config profile for global install. |
| [0007](adr/0007-memory-admin-web-ui.md) | Memory-admin web UI. |
| [0008](adr/0008-interactive-control-panel.md) | Interactive control panel. |
| [0009](adr/0009-atlas-migration-via-driver.md) | Database migration to Atlas (`aitl migrate-atlas`). |
| [0026](adr/0026-auto-bootstrap-local-root.md) | Auto-bootstrap a local root user. |
| [0027](adr/0027-versioning-adrs-memory.md) | Append-only versioning of ADRs and memory. |
| [0028](adr/0028-software-projects-repos-hierarchy.md) | Software → projects → repos hierarchy. |
| [0029](adr/0029-knowledge-map-multi-entity.md) | Multi-entity knowledge map. |
| [0030](adr/0030-builder-and-master-indexer-skills.md) | Definition-builder + master-indexer skills. |
| [0031](adr/0031-branch-classification-graph.md) | Branch classification and branch graph. |
| [0036](adr/0036-mongoose-data-layer.md) | Data layer migrated from the raw driver + Zod to Mongoose. |
| [0037](adr/0037-branch-aware-repomap.md) | Branch-aware repo map with a constant storage footprint. |
| [0038](adr/0038-local-openai-compatible-providers.md) | Local OpenAI-compatible providers (lmstudio, openai-compat). |
| [0039](adr/0039-pre-post-tool-hooks.md) | In-process pre/post tool hooks in the ToolRegistry. |
| [0040](adr/0040-async-gates-human-approval.md) | Async permission gates + in-loop human approval (`--ask`). |
| [0041](adr/0041-mcp-client-tool-mounting.md) | MCP client: mount remote servers as namespaced tools. |
| [0042](adr/0042-sdd-phase-d-pipeline.md) | SDD phase D: pipeline with first-class memory types (spec/design/task). |

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

## Thesis and planning notes

Working notes for the thesis live under [thesis/](thesis/) (backlog, metric sheet,
task briefs, and the optional Google free-tier profile in
[thesis/GOOGLE-FREE.md](thesis/GOOGLE-FREE.md)). Implementation session logs are in
[sessions/](sessions/).

## Navigation rule

READMEs point at folders; ADRs explain **why** each decision exists; the files under
`src/*` show **how** it is implemented.
