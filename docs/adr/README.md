# Architecture Decision Records (ADR log)

Chronological record of the harness's architecture decisions, in the Nygard format
(Context / Decision / Consequences). Each ADR lives as markdown in git **and** is mirrored
into MongoDB's `decisions` collection via `aitl adr-sync --dir docs/adr --project <p>`
(see [ADR-0001]). Numbering continues the shared thesis corpus.

**Source of truth:** the `decisions` collection in MongoDB — query it with `aitl` /
`list_decisions` or the web UI. Files are exported one-way (`aitl adr-sync` = file → ledger);
some ADRs live only in the ledger (rows marked "ledger only" below).

| ADR | Title | Status | File |
|---|---|---|---|
| 0001 | Record architecture decisions | Accepted | [md](0001-record-architecture-decisions.md) |
| 0002 | MongoDB Atlas Vector Search as the single durable store | Accepted | [md](0002-mongodb-atlas-vector-search.md) |
| 0003 | Interactive TUI ("live agent chat") as a first-class CLI surface | Accepted | [md](0003-interactive-tui-live-agent-chat.md) |
| 0004 | Ink (React for the terminal) as the TUI rendering library | Accepted | [md](0004-ink-as-tui-rendering-library.md) |
| 0005 | Extend the ProviderPort with streaming before the TUI | Accepted | [md](0005-streaming-in-provider-port.md) |
| 0006 | User-level config profile (`~/.aitl/config.json`) with export/import | Accepted | [md](0006-user-level-config-profile.md) |
| 0007 | Memory-admin web UI over an HTTP projection of `MemoryStore` | Accepted | [md](0007-memory-admin-web-ui.md) |
| 0008 | Interactive control panel (`aitl -i`) | Accepted | [md](0008-interactive-control-panel.md) |
| 0009 | DB migration to Atlas via the Node driver (`aitl migrate-atlas`) | Accepted | [md](0009-atlas-migration-via-driver.md) |
| 0010–0025 | Seedlist fallback; native agents/skills collections; session-memory lifecycle; skills router; deterministic gate enforcement; loop resilience; system-prompt hydration; heuristic repo map; thin orchestrator; OpenRouter provider; global install + rename to `aitl-mcp`; host context hooks; POSIX hook paths; RBAC gateway | Accepted | ledger only |
| 0026 | Auto-bootstrap of a local root user | Accepted | [md](0026-auto-bootstrap-local-root.md) |
| 0027 | Append-only versioning of ADRs & memory (`*_history`) | Accepted | [md](0027-versioning-adrs-memory.md) |
| 0028 | software → projects → repos hierarchy (sub-scope `repo`) | Accepted | [md](0028-software-projects-repos-hierarchy.md) |
| 0029 | Multi-entity knowledge map (graphify + UI) | Accepted | [md](0029-knowledge-map-multi-entity.md) |
| 0030 | Builder + master indexer skills | Accepted | [md](0030-builder-and-master-indexer-skills.md) |
| 0031 | Branch classification + GitHub-style graph | Accepted | [md](0031-branch-classification-graph.md) |
| 0032 | Pilot instrumentation (T1/T3 slice, C0/C2, `run-show`, quality gate) | Accepted | ledger only |
| 0033 | Composable engineering roles (H11) + human-intervention metric | Accepted | ledger only |
| 0034 | Tokens on `run-host` + SDD spec synthesis + Runs UI tab | Accepted | ledger only |
| 0035 | Per-session graph (`capture-session` links artifacts to a run) | Accepted | ledger only |
| 0036 | Data layer migrated from the raw mongodb driver + Zod to Mongoose | Accepted | [md](0036-mongoose-data-layer.md) |
| 0037 | Branch-aware repo map with a constant storage footprint | Accepted | [md](0037-branch-aware-repomap.md) |
| 0038 | Local OpenAI-compatible providers (lmstudio, openai-compat) | Accepted | [md](0038-local-openai-compatible-providers.md) |
| 0039 | In-process pre/post tool hooks in the ToolRegistry | Accepted | [md](0039-pre-post-tool-hooks.md) |
| 0040 | Async permission gates + in-loop human approval (`--ask`) | Accepted | [md](0040-async-gates-human-approval.md) |
| 0041 | MCP client: mount remote servers as namespaced tools | Accepted | [md](0041-mcp-client-tool-mounting.md) |
| 0042 | SDD phase D: pipeline with first-class memory types (spec/design/task) | Accepted | [md](0042-sdd-phase-d-pipeline.md) |
| 0043 | Provider↔loop round-trip fixes from the first live run (gemma-4 via LM Studio) | Accepted | ledger only |
| 0044 | Direct Anthropic provider + single `AITL_API_KEY` + cross-backend fallback + Claude Code–style chat (amends ADR-0020) | Accepted | ledger only |

> **Reconciliation note.** The ledger is contiguous **0001–0044** (next free **0045**),
> verified against the `decisions` collection. ADRs **0010–0025**, **0032–0035** and
> **0043–0044** exist in the ledger but are not exported as `.md` files here — inspect them
> with `aitl` / `list_decisions` or the web UI. `aitl adr-sync` operates file → ledger; the reverse
> (ledger → file) is done selectively. This index is reconciled *toward* the ledger, never the reverse.

[ADR-0001]: 0001-record-architecture-decisions.md
