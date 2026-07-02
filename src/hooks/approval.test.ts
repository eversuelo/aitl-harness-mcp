import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { type Tool, ToolRegistry } from "../tools/base.js";
import { type ApprovalEvent, approvalGate, installApprovalGate } from "./approval.js";

class SideEffectTool implements Tool {
  readonly name = "danger";
  readonly description = "A tool with side effects.";
  readonly inputSchema = { type: "object", properties: {} };
  readonly requiresApproval = true;
  async run(): Promise<string> {
    return "did the thing";
  }
}

class SafeTool implements Tool {
  readonly name = "safe";
  readonly description = "A read-only tool.";
  readonly inputSchema = { type: "object", properties: {} };
  async run(): Promise<string> {
    return "read something";
  }
}

type TestStream = PassThrough & { isTTY?: boolean };

function ttyStream(): TestStream {
  const s = new PassThrough() as TestStream;
  s.isTTY = true;
  return s;
}

function setup(input: TestStream, policy?: "deny" | "allow") {
  const registry = new ToolRegistry();
  registry.register(new SideEffectTool());
  registry.register(new SafeTool());
  const events: ApprovalEvent[] = [];
  const gate = approvalGate({
    registry,
    policy,
    input,
    output: new PassThrough(), // swallow the prompt
    onDecision: (ev) => events.push(ev),
  });
  registry.addGate(gate);
  return { registry, events };
}

// NOTE on answer timing: each question creates its OWN readline interface, and an
// interface slurps everything already buffered in the stream. So answers must be
// written just-in-time — one per pending question — never pre-buffered in bulk.
// (registry.call runs synchronously up to rl.question, so the interface is always
// listening by the time the un-awaited call returns.)

test("non-TTY + default policy denies and audits the decision", async () => {
  const input = new PassThrough() as TestStream; // isTTY undefined → non-interactive
  const { registry, events } = setup(input);
  const out = await registry.call("danger", {});
  assert.match(out, /^\[denied by gate\] approval denied for 'danger'/);
  assert.deepEqual(events, [{ tool: "danger", decision: "deny", ms: 0, interactive: false }]);
});

test("non-TTY + policy allow lets the tool run", async () => {
  const input = new PassThrough() as TestStream;
  const { registry, events } = setup(input, "allow");
  const out = await registry.call("danger", {});
  assert.equal(out, "did the thing");
  assert.equal(events[0].decision, "allow");
  assert.equal(events[0].interactive, false);
});

test("TTY 'y' approves once; the next call asks again", async () => {
  const input = ttyStream();
  const { registry, events } = setup(input);
  const p1 = registry.call("danger", {});
  input.write("y\n");
  assert.equal(await p1, "did the thing");
  const p2 = registry.call("danger", {});
  input.write("n\n");
  assert.match(await p2, /^\[denied by gate\]/);
  assert.deepEqual(
    events.map((e) => e.decision),
    ["allow", "deny"],
  );
  assert.ok(events.every((e) => e.interactive));
});

test("TTY 'a' (always) approves and never asks again for that tool", async () => {
  const input = ttyStream();
  const { registry, events } = setup(input);
  const p1 = registry.call("danger", {});
  input.write("a\n");
  assert.equal(await p1, "did the thing");
  // No answer written for the second call — it must resolve without prompting.
  assert.equal(await registry.call("danger", {}), "did the thing");
  assert.deepEqual(
    events.map((e) => e.decision),
    ["always"],
  );
});

test("an empty answer denies (safe default)", async () => {
  const input = ttyStream();
  const { registry, events } = setup(input);
  const p = registry.call("danger", {});
  input.write("\n");
  assert.match(await p, /^\[denied by gate\]/);
  assert.equal(events[0].decision, "deny");
});

test("tools without requiresApproval never prompt", async () => {
  const input = new PassThrough() as TestStream; // would deny if consulted
  const { registry, events } = setup(input);
  assert.equal(await registry.call("safe", {}), "read something");
  assert.equal(events.length, 0);
});

test("installApprovalGate is idempotent per registry (no duplicate prompts)", async () => {
  const registry = new ToolRegistry();
  registry.register(new SideEffectTool());
  const events: ApprovalEvent[] = [];
  const input = new PassThrough() as TestStream; // non-interactive
  installApprovalGate(registry, { policy: "allow", input, onDecision: (ev) => events.push(ev) });
  installApprovalGate(registry, { policy: "allow", input, onDecision: (ev) => events.push(ev) });
  await registry.call("danger", {});
  // One gate → exactly one decision, even after a double install (e.g. chat turns).
  assert.equal(events.length, 1);
});

test("re-installing updates the policy of the existing gate", async () => {
  const registry = new ToolRegistry();
  registry.register(new SideEffectTool());
  const input = new PassThrough() as TestStream;
  installApprovalGate(registry, { policy: "deny", input });
  installApprovalGate(registry, { policy: "allow", input });
  assert.equal(await registry.call("danger", {}), "did the thing");
});
