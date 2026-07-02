import assert from "node:assert/strict";
import { test } from "node:test";
import { type Tool, type ToolHookEvent, ToolRegistry } from "./base.js";

/** Echo tool: returns its args as JSON so tests can observe what the tool saw. */
class EchoTool implements Tool {
  readonly name = "echo";
  readonly description = "Echo the args back as JSON.";
  readonly inputSchema = { type: "object", properties: { msg: { type: "string" } } };
  async run(args: Record<string, unknown>): Promise<string> {
    return JSON.stringify(args);
  }
}

class ThrowingTool implements Tool {
  readonly name = "boom";
  readonly description = "Always throws.";
  readonly inputSchema = { type: "object", properties: {} };
  async run(): Promise<string> {
    throw new Error("kaboom");
  }
}

function freshRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(new EchoTool());
  return r;
}

test("pre-hook mutations are visible to the tool and chain in order", async () => {
  const r = freshRegistry();
  r.addPreHook((_name, args) => ({ args: { ...args, a: 1 } }));
  r.addPreHook((_name, args) => ({ args: { ...args, b: 2 } })); // sees a:1 from the first hook
  const out = JSON.parse(await r.call("echo", { msg: "hi" }));
  assert.deepEqual(out, { msg: "hi", a: 1, b: 2 });
});

test("post-hook can transform the result", async () => {
  const r = freshRegistry();
  r.addPostHook((_name, _args, result) => ({ result: result.toUpperCase() }));
  const out = await r.call("echo", { msg: "hi" });
  assert.match(out, /"MSG": ?"HI"/i);
  assert.equal(out, out.toUpperCase());
});

test("onHookEvent fires ONLY when a hook mutates", async () => {
  const r = freshRegistry();
  const events: ToolHookEvent[] = [];
  r.addPreHook(() => {
    /* observes, does not act */
  });
  r.addPreHook(() => ({ args: { rewritten: true } }));
  r.addPostHook(() => ({ result: "done" }));
  await r.call("echo", { msg: "hi" }, undefined, { onHookEvent: (ev) => events.push(ev) });
  assert.deepEqual(
    events.map((e) => `${e.phase}:${e.index}`),
    ["pre:1", "post:0"],
  );
});

test("a denying gate short-circuits before any pre-hook runs", async () => {
  const r = freshRegistry();
  let hookRan = false;
  r.addGate(() => [false, "nope"]);
  r.addPreHook(() => {
    hookRan = true;
  });
  const out = await r.call("echo", { msg: "hi" });
  assert.equal(out, "[denied by gate] nope");
  assert.equal(hookRan, false);
});

test("a throwing pre-hook aborts the call — the tool never runs", async () => {
  const r = new ToolRegistry();
  let toolRan = false;
  r.register({
    name: "probe",
    description: "flips a flag",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      toolRan = true;
      return "ran";
    },
  });
  r.addPreHook(() => {
    throw new Error("policy says no");
  });
  const out = await r.call("probe", {});
  assert.match(out, /^\[tool error\] policy says no/);
  assert.equal(toolRan, false);
});

test("a throwing post-hook is skipped and the result is preserved", async () => {
  const r = freshRegistry();
  r.addPostHook(() => {
    throw new Error("broken observer");
  });
  r.addPostHook((_n, _a, result) => ({ result: `${result}!` })); // later hooks still run
  const out = await r.call("echo", { msg: "hi" });
  assert.ok(out.endsWith("!"));
  assert.match(out, /"msg":"hi"/);
});

test("tool errors still surface as [tool error] with hooks installed", async () => {
  const r = new ToolRegistry();
  r.register(new ThrowingTool());
  r.addPostHook(() => ({ result: "should not matter" })); // post-hooks don't run on a throw
  const out = await r.call("boom", {});
  assert.equal(out, "[tool error] kaboom");
});

test("call() without the opts arg keeps working (backwards compat)", async () => {
  const r = freshRegistry();
  r.addPreHook((_n, args) => ({ args: { ...args, extra: true } }));
  const out = JSON.parse(await r.call("echo", { msg: "hi" }));
  assert.equal(out.extra, true);
});
