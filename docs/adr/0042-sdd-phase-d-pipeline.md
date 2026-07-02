# ADR-0042 — SDD phase D: pipeline with first-class memory types (spec/design/task)

- **Status:** Accepted
- **Date:** 2026-07-01

## Context
Pillar 4 (SDD) stopped at classification and synthesis: `classifySpec` labels a
prompt (ADR-0034) and `synthesizeSpecRun` compresses a finished host run into one
`type:"synthesis"` doc. The phase-D promise — persisted artifacts flowing
*proposal → spec → design → tasks* — had no implementation: no way to formalize an
ad-hoc task into a spec, derive a design, or decompose into tasks, and nowhere for
those artifacts to live as queryable, first-class records.

Two modeling options: dedicated Mongoose collections (SpecDoc/DesignDoc/TaskDoc), or
new MEMORY types. Dedicated models add migrations, guards and UI for what are
fundamentally project-memory documents; tags alone (on `synthesis`) overload a type
the synthesizer already treats specially.

## Decision
1. **First-class memory types.** `MEMORY_TYPES` gains `"spec" | "design" | "task"`
   (additive Mongoose enum — old docs stay valid). A new `RESERVED_MEMORY_TYPES` set
   (`synthesis` + the three SDD types) replaces the hardcoded `!== "synthesis"`
   guards in the web API and the MCP `write_memory` tool: external writers get
   coerced to `"project"`, only harness pipelines write reserved types. The memory
   synthesizer skips all reserved types (pipeline outputs are records, not raw
   memory to compact).
2. **Pipeline modules** (`src/specs/`): `ensureSpec` persists a spec-shaped prompt
   VERBATIM (the engineer's words are the spec of record) or formalizes an ad-hoc
   task via the provider (user story + acceptance criteria); `generateDesign`
   derives a short design doc; `decomposeTasks` demands STRICT JSON with ONE repair
   retry (same discipline as roles/engine) and fails loudly otherwise.
3. **Chaining by tags.** Slugs `sdd-spec-<id8>` / `sdd-design-<id8>` /
   `sdd-task-<id8>-NN`; every artifact carries `["sdd", "run:<id8>"]` and children
   point at their parent (`parent:sdd-spec-<id8>`, `parent:sdd-design-<id8>`), so
   the chain is walkable in both directions.
4. **Runs telemetry for free.** `runSddPipeline` records one Run doc
   (`harness_config.sdd = true`, `spec: true`, status done/error) and one
   `synthesis` event per phase (`payload.kind: spec|design|tasks`) — the pipeline
   appears in `run-show` and the web UI Runs tab with zero new UI.
5. **CLI:** `aitl sdd <prompt> --project P [--model M] [--repo R] [--max-tasks N]`.

## Consequences
- The SDD chain is queryable (`type:"spec"`, tag `run:<id8>`) and each task is a
  ready-to-run prompt for `aitl run` / a host — closing the loop from spec to
  executable work.
- The parity contract does not pin MEMORY_TYPES (verified), but the Python port must
  add the three types before reading these docs type-safely — noted as a parity
  follow-up.
- The web UI creation dropdown intentionally omits reserved types; docs with the new
  types list and render unchanged.
- Local models can run the whole pipeline (`--model lmstudio`): three `complete()`
  calls, no tool use required.
