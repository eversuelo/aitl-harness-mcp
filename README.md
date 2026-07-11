# AITL — Agent In The Loop

A model-agnostic agent harness with durable, structured memory in MongoDB (Atlas Vector
Search), an MCP server, and a CLI. TypeScript / ESM.

The published npm package is **`aitl-mcp`**; it installs a global binary named **`aitl`**.

---

## Features

- **Durable memory.** Mongoose models over MongoDB + [Atlas Vector Search](https://www.mongodb.com/products/platform/atlas-vector-search).
  A single durable store holds runs, transcripts, memory, decisions, prompts, symbols and
  events. Local embeddings via [`@xenova/transformers`](https://www.npmjs.com/package/@xenova/transformers)
  (`Xenova/all-MiniLM-L6-v2`, 384-dim) by default; Voyage AI is an alternative provider.
- **MCP server.** `aitl mcp` exposes the durable state to any MCP client (Claude Code,
  Cursor, …) over stdio or Streamable HTTP. The canonical project key is `aitl-js`.
- **Global CLI.** The `aitl` binary drives ingest, search, agent runs, host runs,
  orchestration, the repo map, ADR sync, the web UI and more.
- **Composable engineering roles (H11).** Security / DevOps / QA / architect / DevSecOps
  roles run in `review`, `pair` or `gate` mode and produce a **DecisionBrief** that assists
  the engineer's decision (attributed objections; deterministic gate veto).
- **Engineered, verifiable loop (ADR-0062).** The loop policy is a versioned spec
  (LoopSpec): composable verifiers gate termination (with bounded verify rounds and an
  optional no-tools reflection turn), a stall detector catches no-progress iterations,
  token/wall-clock budgets end with a wrap-up turn, and every run records WHY it stopped
  (`stop_reason` + `verified`) — an exhausted run can never masquerade as a success.
- **Versioned ADR + memory + prompt ledger.** Architecture Decision Records, memory docs
  and the prompt history are append-only versioned (prior revisions archived in
  `*_history`), inspectable with a field-level diff.
- **Branch-aware repo map.** A tree-sitter + PageRank map of the codebase, classified per
  git branch and fed into a GitHub-style branch graph.
- **Web memory UI.** A local API + SPA to browse Memory, Decisions, Prompts, Runs
  (token/cost telemetry), the state Graph and the Knowledge map.

## Requirements

- **Node.js ≥ 20.**
- **MongoDB with Atlas Vector Search.** The harness queries embeddings with `$vectorSearch`
  and creates indexes with `createSearchIndex`, so a plain `mongod` **will not work**. Use
  one of:
  - the bundled `docker-compose.yml` (image `mongodb/mongodb-atlas-local`, which bundles the
    same Search engine as cloud Atlas), or
  - a real MongoDB Atlas cluster whose tier supports Vector Search.

## Install

Global (recommended) — installs the `aitl` binary:

```bash
npm i -g aitl-mcp
aitl --help
```

From source:

```bash
npm ci
npm run build
npm i -g .
aitl --help
```

## Quickstart (local)

Bring up a local Atlas-capable MongoDB, point the CLI at it, initialize the schema, then
run the MCP server or the web UI:

```bash
docker compose up -d                                                    # local mongodb-atlas-local
aitl config set MONGODB_URI "mongodb://localhost:27017/?directConnection=true"
aitl config set MONGODB_DB aitl
aitl init-db          # create collections, scalar/text indexes and the vector_index
aitl check-db         # validate connectivity + RBAC readiness ("RBAC status: ready")
aitl mcp              # start the MCP server (stdio); or:
aitl ui               # start the web memory UI (API + SPA)
```

Configuration is stored in a user-level profile at `~/.aitl/config.json`, so the same
settings are shared by the CLI, the MCP server and the Claude Code hooks.

## Use with Claude Code (MCP)

Register the server in your repository's `.mcp.json`:

```json
{
  "mcpServers": {
    "aitl-js": { "command": "aitl", "args": ["mcp"] }
  }
}
```

Optionally add Claude Code hooks so durable context is read and written on every turn —
these run the `aitl` binary deterministically, independent of what the model "remembers":

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "aitl hydrate --project aitl-js" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "aitl capture-session --project aitl-js" } ] }
    ]
  }
}
```

- `UserPromptSubmit → aitl hydrate` injects a durable preamble (memory + ADRs + conventions
  + repo map) into each prompt.
- `Stop → aitl capture-session` summarizes the finished session into one memory doc + a
  context snapshot, auto-tagged by the components you touched.

See `.mcp.json.example` for a variant that passes `MONGODB_URI`/`MONGODB_DB` and the
`AITL_MCP_*` server variables through the `env` block instead of relying on the global
profile.

## Configuration

All settings come from environment variables, a `.env` file, or a named config profile.
Layered resolution (ADR-0061), highest wins: **real env > active profile (`AITL_PROFILE`) >
`.env` > `~/.aitl/config.json` > built-in defaults**. Manage them with
`aitl config {set,unset,show,export,import,path}` and
`aitl config profile {list,create,set,show,use,rm}`, or from the web Config tab.

Every variable has a working default: a fresh clone runs against local MongoDB with local
embeddings and — with LM Studio — zero API keys.

### API keys: you need at most one

| Setup | What to set | API keys |
|---|---|---|
| Local & free (LM Studio) | `MODEL_PRIMARY=lmstudio` + a model loaded in LM Studio | none |
| Anthropic first-party | `AITL_API_KEY=sk-ant-…` | one |
| Any model via OpenRouter | `AITL_API_KEY=sk-or-…` | one |

`AITL_API_KEY` is classified by prefix (`sk-ant-*` → Anthropic, `sk-or-*` → OpenRouter) and
fills the matching provider key. The other key variables cover special cases only, and an
explicitly set provider key wins over `AITL_API_KEY`:

- `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` — set these directly only if you configure two
  cloud providers at once.
- `OPENAI_COMPAT_API_KEY` — only if your generic OpenAI-compatible endpoint requires auth.
- `LMSTUDIO_API_KEY` — placeholder (default `lm-studio`); LM Studio ignores it.
- `VOYAGE_API_KEY` — only for the opt-in `voyage` embedding backend. The default embedding
  backend is local and needs no key.

### Core

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017/?directConnection=true` | Primary MongoDB / Atlas connection string. |
| `MONGODB_URI_FALLBACK` | *(empty)* | Optional second URI tried when the primary is unreachable (local ↔ Atlas). |
| `MONGODB_DB` | `aitl` | Database name. |
| `MODEL_PRIMARY` | `openrouter` | Primary model provider (`anthropic` \| `openrouter` \| `lmstudio` \| `openai-compat`). `--model auto` picks the first configured backend (see `aitl models`). |
| `MODEL_SECONDARY` | `openrouter` | Secondary/fallback model provider. |
| `AITL_API_KEY` | *(empty)* | The single key (see above). |
| `AITL_PROFILE` | *(empty)* | Pin a named config profile for this shell/repo (`""` disables any profile). |

### Model providers — only the one you use matters

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Anthropic model id (first-party API: prompt caching + structured outputs + native tool blocks). |
| `ANTHROPIC_MAX_CONTEXT` | `1000000` | Context-window budget assumed for Anthropic. |
| `OPENROUTER_MODEL` | `openrouter/auto` | OpenRouter model id (namespaced, e.g. `anthropic/claude-3.5-sonnet`). |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio local OpenAI-compatible server URL. |
| `LMSTUDIO_MODEL` | *(empty)* | Model loaded in LM Studio; leave empty to auto-detect the loaded model (`aitl models --detect` persists it). |
| `LMSTUDIO_MAX_CONTEXT` | `32768` | Context-window budget assumed for the LM Studio model. |
| `OPENAI_COMPAT_BASE_URL` | *(empty)* | Generic OpenAI-compatible endpoint (Ollama `/v1`, vLLM, LiteLLM, …). |
| `OPENAI_COMPAT_MODEL` | *(empty)* | Model id for the generic endpoint (required together with the base URL). |
| `OPENAI_COMPAT_MAX_CONTEXT` | `128000` | Context-window budget assumed for the generic endpoint. |

### Advanced — defaults work; change only when you know why

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDING_PROVIDER` | `local` | `local` (`@xenova/transformers`, no key) or `voyage` (needs `VOYAGE_API_KEY`). |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model id. |
| `EMBEDDING_DIMS` | `384` | Embedding dimension — **must match the vector index**; changing it means recreate index + re-embed. |
| `MEMORY_MAX_DOCS` | `500` | Per-project doc count that triggers memory synthesis. |
| `MEMORY_MAX_TOKENS` | `200000` | Per-project token budget that triggers memory synthesis. |
| `ENABLED_ADAPTERS` | `agents_md` | Comma-separated list of enabled cross-tool adapters. |
| `AITL_WEB_ORIGINS` | Vite dev/preview ports | CORS allowlist (CSV of origins) for the web API. |
| `AITL_WEB_ALLOW_SIGNUP` | `true` | Self-service signup toggle for the web UI. |
| `AITL_BOOTSTRAP_USERNAME` / `_EMAIL` / `_PASSWORD` | *(empty)* | Optional explicit bootstrap user (see RBAC docs); password stored hashed. |
| `AITL_BOOTSTRAP_ROLE` | `root` | Bootstrap user role. |
| `AITL_BOOTSTRAP_AUTOGEN` | `true` | Auto-generate a local root when `users` is empty (set `false` for multi-tenant). |
| `MODEL_HOST` | *(empty)* | Reserved (`codex` \| `claude-code` \| `antigravity`) — not consumed yet; agent hosts run via `aitl run-host`. |

MCP-server variables (read by `aitl mcp`; not part of the config profile):

| Variable | Default | Purpose |
|---|---|---|
| `AITL_MCP_PROJECT` | `mcp` | Fallback project when a tool call omits `project`. |
| `AITL_MCP_LOG_FILE` | *(stderr)* | File to log MCP tool calls to. |
| `AITL_MCP_LOG_RESULT_CHARS` | `4000` | Max chars of each tool result logged. |
| `AITL_MCP_CONTEXT_CHARS` | `100000` | Max chars stored per saved MCP context. |
| `AITL_MCP_ACTOR_ID` / `AITL_MCP_ACTOR_ROLE` | `agent:aitl-server` / `agent` | RBAC identity the MCP server acts as. |
| `AITL_MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `AITL_MCP_HOST` / `AITL_MCP_PORT` / `AITL_MCP_PATH` | `127.0.0.1` / `8000` / `/mcp` | HTTP transport bind. |
| `AITL_MCP_SOCKET_PATH` | *(empty)* | Unix socket for the HTTP transport. |
| `AITL_MCP_TOKEN` | *(empty)* | Bearer token required when exposed off localhost. |
| `AITL_MCP_DNS_REBINDING` / `AITL_MCP_ALLOWED_HOSTS` | `1` / *(localhost)* | DNS-rebinding protection and allow-list. |

## CLI commands

Run `aitl --help` (or `aitl <group> --help`) for full options. For a per-command guide
organized by the **software → project → repo → branch** hierarchy, see
[`docs/GUIA-CLI.md`](docs/GUIA-CLI.md) (Spanish). Top-level commands:

| Command | Purpose |
|---|---|
| `aitl` / `aitl interactive` | Launch the interactive control panel (supervise MCP/UI, run commands; the "Chat ▸" submenu — shortcut `c` — opens `aitl chat` per provider/mode). |
| `aitl check-db` | Validate MongoDB connectivity/auth (primary then fallback) and RBAC readiness. |
| `aitl init-db` | Create collections, scalar/text indexes and Atlas vector indexes. |
| `aitl ingest` | Parse → classify → embed → upsert markdown memory. |
| `aitl search` | Semantic search via `$vectorSearch` (falls back to text search). |
| `aitl run` | Run the model-agnostic agent loop, persisting the run/transcript to Mongo. |
| `aitl chat` | Claude Code–style REPL over the agent loop (streams, live tool trace, `/help`; `--model auto` picks the configured backend + fallback chain). |
| `aitl models` | Show which LLM backends are configured, the active one, and the fallback chain (`--json`). |
| `aitl sdd` | SDD phase D: spec → design doc → task decomposition, persisted as linked memory artifacts. |
| `aitl intervene` | Record a human intervention on a run (human-supervision metric). |
| `aitl run-show` | Show a run's measurable totals: tokens, iterations, tool calls, gate denials, hydrate. |
| `aitl run-host` | Run a task OVER an external agent host (Codex/Claude Code/Antigravity), wrapped with durable context + telemetry. Permissions travel explicitly on the argv (`--permission-mode`, `--allowed-tools`; `AITL_HOST_ARGS_<NAME>` for any host) — never via the target dir's settings/trust. |
| `aitl orchestrate` | Decompose a task, run sub-agents in parallel, and synthesize the result. |
| `aitl council` | Plan-council: several clients PROPOSE a plan, CRITIQUE each other anonymously against a weighted rubric, and an independent judge issues the verdict — before executing anything. Hosts run read-only. |
| `aitl synthesize` | Rolling memory compression: fold the previous synthesis + only the new docs per category (map-reduce, nothing silently truncated). `--compact` archives absorbed sources out of the live memory (hydrate/trigger) without deleting them. |
| `aitl sync` | Bidirectional markdown sync: Mongo ⇄ `.aitl/{memory,skills,agents}` + `docs/adr` (manifest-based; conflicts reported, never clobbered). |
| `aitl module-brief` | Render a module's brief: module-map block + ACTIVE ADRs whose `components[]` match the dir + memories tagged `component:<dir>`. |
| `aitl repomap` | Build the tree-sitter + PageRank repo map and print the top symbols. |
| `aitl index-repo` | Master indexer: build repo map + ingest memory + sync ADRs in one pass. |
| `aitl adr-sync` | Mirror Nygard-format ADRs from a directory into the `decisions` collection. |
| `aitl export` | Project the canonical artifacts into a tool's native format (incremental). |
| `aitl mcp` | Run the MCP server (stdio by default; `--http` for remote clients). |
| `aitl ui` | Launch the memory-admin UI (HTTP API + SPA). |
| `aitl hydrate` | Print a durable-context preamble to inject into an external agent host. |
| `aitl capture-session` | Capture a finished host session into durable memory + a context snapshot. |
| `aitl migrate-atlas <target-uri>` | Copy a database to another MongoDB/Atlas cluster (data only). |

Sub-command groups:

| Group | Commands | Purpose |
|---|---|---|
| `aitl user` | `bootstrap`, `register`, `verify`, `list`, `create`, `set-role`, `disable` | Manage RBAC users (`register` is self-service; first real user becomes admin; audited). |
| `aitl config` | `path`, `show`, `export`, `import`, `set`, `unset`, `profile {list,create,set,show,use,rm}` | Manage the user-level config profile and named profile overlays (ADR-0061). |
| `aitl prompt` | `add`, `list`, `search` | Durable prompt history (shared with the MCP). |
| `aitl adr` | `history <id>`, `deprecate <id>` | Inspect ADR revision history (`--diff`); deprecate with a reason / `superseded_by` (soft lifecycle — excluded from hydrate, never deleted). |
| `aitl memory` | `history <slug>` | Inspect memory revision history (`--diff`). |
| `aitl software` | `add`, `list`, `get`, `rm` | Manage software (software → projects → repos). |
| `aitl repo` | `add`, `list`, `get`, `rm` | Manage repos (the leaf of software → projects → repos). |
| `aitl branch` | `sync`, `list`, `rm` | Classify git branches and feed the branch graph. |
| `aitl role` | `seed`, `list`, `rm`, `gate-check` | Engineering roles (review/pair/gate) that assist the engineer's decision. |
| `aitl review <target>` | — | Have engineering roles review a target → DecisionBrief. |
| `aitl build` | `skill`, `agent`, `seed` | Construct skills/agents and seed the master skills. |
| `aitl coord` | `claim`, `release`, `list`, `poll` | Minimal multi-agent coordination: task claims (heartbeat + TTL) + durable events + incremental polling. |
| `aitl init` | *(bare)*, `agent`, `claude` | Onboard a repo into the harness in one idempotent command (DB + catalog + index + guides + hooks), or scaffold single guides. |

### Loop engineering (ADR-0062)

`aitl run` executes a loop whose termination is **verified, budgeted and stall-aware**,
and whose policy is a **versioned specification**:

- **Verification gates termination.** `--verify-cmd "npm test"` (or programmatic
  `verifiers[]`) must pass for the run to end — including when the iteration window is
  exhausted, so an exhausted run is reported as `stop_reason=max_iters`, never as a
  success. Each failed verification grants a fresh work window, bounded by
  `--max-verify-rounds` (then `verify_exhausted`).
- **Stall detection.** If consecutive iterations repeat the same tool calls with an
  unchanged workspace (`--stall-threshold`, default 3), the loop injects corrective
  feedback; a second strike ends the run as `stalled`.
- **Budgets.** `--budget-tokens` / `--budget-ms` end the run with one final no-tools
  wrap-up turn ("summarize state") instead of a hard cut (`stop_reason=budget`).
- **Reflection.** `--reflect` forces a no-tools diagnosis turn after each failed
  verification before the model may act again.
- **LoopSpec.** `--loop-spec <nameOrPath>` loads the whole policy from a JSON file (or
  the durable `loops` collection), identified by a content-hash version. The resolved
  policy — and `loop_spec@version` — is stamped into the run's `harness_config`, so any
  measurement can state exactly which loop design produced it. Explicit flags override
  spec fields.

```json
{ "name": "thesis-c2", "maxIters": 15, "stallThreshold": 2,
  "maxVerifyRounds": 3, "reflect": true, "verifyCmd": "npm test",
  "budgets": { "tokens": 120000, "ms": 900000 } }
```

Every outcome is durable: `stop_reason` (`completed` | `max_iters` | `verify_exhausted`
| `stalled` | `budget`), `verified`, `verify_rounds` and `stall_strikes` land on the run
doc, and `stall` / `budget` / `reflection` / per-verifier `verify` events join the
existing trace.

### Experimental comparison (thesis conditions)

There is no separate eval command. The harness-vs-bare comparison runs the same task
under two conditions of `aitl run`: **C0** — `aitl run --bare` (no memory hydrate, no
skills, no gates) — vs **C2** — the default full harness. Compare the measurable totals
(tokens, iterations, tool calls, gate denials, supervision) with `aitl run-show <runId>`.

## MCP tools

`aitl mcp` registers 52 tools, grouped by domain:

- **Memory** — `search_memory`, `write_memory`, `ingest_path`, `save_mcp_context`,
  `list_mcp_context`, `search_mcp_context`.
- **Prompts** — `record_prompt`, `list_prompts`, `search_prompts`.
- **Decisions (ADR)** — `list_decisions`, `record_decision`, `deprecate_decision`,
  `list_decision_versions`, `get_decision_version`.
- **Memory versions** — `list_memory_versions`, `get_memory_version`.
- **Agents & skills** — `write_agent`, `get_agent`, `list_agents`, `search_agents`,
  `delete_agent`, and the same surface for skills (`write_skill`, `get_skill`,
  `list_skills`, `search_skills`, `delete_skill`).
- **Repo map & graph** — `get_repomap`, `get_module_map`, `get_module_brief`, `graphify`,
  `index_repo`, `build_definition`.
- **Coordination** — `claim_task`, `release_task`, `poll_events` (task claims with TTL +
  durable events, RBAC resource `coordination`).
- **Agent runs** — `run_agent` (the full verifiable loop via MCP: `verify_cmd`, `loop_spec`,
  budgets; ADR-0063).
- **Software / repo catalog** — `write_software`, `get_software`, `list_softwares`,
  `search_softwares`, `delete_software`, `write_repo`, `get_repo`, `list_repos`,
  `delete_repo`.
- **Branches** — `sync_branches`, `list_branches`, `delete_branch`.
- **Roles** — `list_roles`, `write_role`, `seed_roles`.
- **Human-in-the-loop** — `record_human_intervention`.

All tools take a `project` argument; keep it consistent (`aitl-js` for this repo) so history
stays in one place.

## Engineering roles (H11)

The harness ships composable engineering roles — **security**, **devops**, **qa**,
**architect**, **devsecops** — that run in one of three modes:

- **review** — critique a target at close-out and attribute objections.
- **pair** — advise inline while the agent works.
- **gate** — a deterministic veto that must pass before the loop can close.

The output is a **DecisionBrief** that assists (never replaces) the engineer's decision.

```bash
aitl role seed --project aitl-js                          # create the role catalog
aitl review @diff.txt --project aitl-js --roles security,architect
aitl role gate-check .env --project aitl-js --role security   # deterministic veto (no model)
aitl run "task" --project aitl-js --roles security,qa         # couple roles to the loop
```

## Data layer

The durable store is defined by **Mongoose models in `src/models/*.model.ts`** (replacing
the earlier raw `mongodb` driver + Zod schemas — the data-layer migration is complete;
Mongoose is now the single source of shape, validation and types). Documents stay
byte-compatible with the pre-migration data.

Retrieval uses **MongoDB + Atlas `$vectorSearch`** with a resilient cascade: vector search
→ full-text (`$text`) → recency. This means memory, decisions and skills keep working even
before the Atlas vector index is `READY` or if embeddings fail. See
[ADR-0036](docs/adr/) (Mongoose migration) and [ADR-0037](docs/adr/) (branch-aware repo
map).

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test over src/**/*.test.ts
npm run build        # tsc -> dist/
```

Run without a global install:

```bash
npm run dev:cli -- --help
npm run dev:mcp      # MCP server (watch)
npm run dev:ui       # web UI (watch)
```

## Publishing

```bash
npm login
npm publish
```

`prepublishOnly` runs `npm run verify` (typecheck + tests) and `prepare` runs the build, so
`dist/` is always produced before publish. Only `dist/` is published (see `files` in
`package.json`).

## License

[MIT](LICENSE).
