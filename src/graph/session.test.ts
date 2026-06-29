import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleSessionGraph } from "./session.js";

test("assembleSessionGraph links a run to its produced artifacts", () => {
  const g = assembleSessionGraph(
    { runId: "abcd1234-0000", project: "p", model: "host:claude-code", tokensTotal: 1000, status: "done" },
    {
      decisions: [{ id: "0034", label: "ADR-0034 X", basis: "artifact" }],
      memories: [
        { id: "mem-a", label: "mem-a", basis: "artifact", extra: { links: ["mem-b"] } },
        { id: "mem-b", label: "mem-b", basis: "tag", extra: { links: [] } },
      ],
      prompts: [{ id: "p1", label: "spec", basis: "run_id" }],
    },
  );
  const runNode = g.nodes.find((n) => n.kind === "run");
  assert.ok(runNode, "has a run node");
  // 1 run + 1 decision + 2 memories + 1 prompt = 5 nodes
  assert.equal(g.nodes.length, 5);
  // 4 produced edges (run→each artifact) + 1 memory link (mem-a→mem-b)
  assert.equal(g.edges.filter((e) => e.type === "produced").length, 4);
  assert.equal(g.edges.filter((e) => e.type === "link").length, 1);
});

test("assembleSessionGraph keeps memory links only among included memories", () => {
  const g = assembleSessionGraph(
    { runId: "r", project: "p" },
    {
      decisions: [],
      memories: [{ id: "mem-a", label: "a", basis: "artifact", extra: { links: ["not-included"] } }],
      prompts: [],
    },
  );
  assert.equal(g.edges.filter((e) => e.type === "link").length, 0);
});
