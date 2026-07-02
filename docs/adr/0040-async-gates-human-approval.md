# ADR-0040 — Async permission gates + in-loop human approval (`--ask`)

- **Status:** Accepted
- **Date:** 2026-07-01

## Context
The harness records human supervision only after the fact (`aitl intervene`,
`human_intervention` events): the human signs the autopsy, never steers the run. The
thesis' operating formula — *human in the loop when ambiguity or risk appears* —
demands a control point BEFORE a side-effect executes. Deterministic gates
(`denyPathsGate`, `roleGate`) are policy, not judgment: they cannot ask.

Asking requires waiting on a terminal, so gates must be allowed to be async. The
`PermissionGate` type was strictly synchronous, and `roleGate` destructures another
gate's verdict synchronously.

## Decision
1. **Async gates, backwards compatible.** `PermissionGate` now returns
   `GateVerdict | Promise<GateVerdict>`; `ToolRegistry.call()` awaits each verdict
   (a no-op for plain tuples). Concrete deterministic factories (`denyPathsGate`,
   `PhaseGate.asGate`, `roleGate`) are typed `SyncPermissionGate`, so code that
   destructures their result directly keeps compiling unchanged.
2. **`Tool.requiresApproval`** (also on `ToolPort`): opt-in marker for side-effect
   tools. Built-ins: `write_file` and `shell` are marked; `read_file` is not.
3. **`approvalGate` (src/hooks/approval.ts):** async gate that prompts on stderr
   (stdout stays clean for `--stream`): `y`/`s`/`sí` allow once, `a` allows the tool
   for the rest of the process, anything else — including empty — denies. Without a
   TTY the `policy` fallback decides (default `deny`), and the run never hangs.
   `installApprovalGate` is idempotent per registry (re-installs only re-point the
   runtime opts), so multi-turn callers (`aitl chat`) never stack duplicate prompts.
4. **Wiring:** `runAgent` gains `ask` / `askPolicy`; the gate is registered AFTER the
   deterministic gates, so a human is never asked about a call policy would deny
   anyway. Every decision is audited as an `approval` event with the human's answer
   latency (`ms`).
5. **Metric:** `aitl run-show` rolls approvals up as `approvals: {count, ms}` and
   `supervision_minutes = intervention_minutes + approval_ms / 60000` — the H11
   human-supervision metric now includes in-loop steering, not just post-hoc notes.

## Consequences
- The human becomes a first-class sensor in the loop; denials flow back to the model
  as `[denied by gate]` results it can react to, and count in `gate_denials`.
- Approval latency is measurable per run — comparable across conditions in the
  experiment (supervised vs. autonomous).
- MCP-mounted tools (ADR-0041) inherit the mechanism via `requiresApproval`.
- A denied approval is indistinguishable from a policy denial to the model
  (intentional: same recovery path), but distinguishable in telemetry
  (`approval` vs `gate` events).
