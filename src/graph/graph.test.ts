import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoryGraph, buildProjectGraph, buildSymbolGraph } from "./build.js";
import { graphify } from "./index.js";
import { graphToDot } from "./serialize.js";
import type { GraphSource, MemoryRow, SymbolRow } from "./index.js";

test("buildSymbolGraph: nodes per symbol, ref edges resolve by name", () => {
  const symbols: SymbolRow[] = [
    { file: "a.ts", name: "foo", refs: ["bar"], pagerank: 0.5 },
    { file: "b.ts", name: "bar", refs: ["foo", "missing"] },
  ];
  const g = buildSymbolGraph(symbols, "p");
  assert.equal(g.nodes.length, 2);
  assert.deepEqual(
    g.nodes.map((n) => n.id),
    ["sym:a.ts::foo", "sym:b.ts::bar"],
  );
  // foo->bar and bar->foo resolve; "missing" has no node so no edge.
  assert.deepEqual(g.edges, [
    { source: "sym:a.ts::foo", target: "sym:b.ts::bar", type: "ref" },
    { source: "sym:b.ts::bar", target: "sym:a.ts::foo", type: "ref" },
  ]);
});

test("buildSymbolGraph: no self-edges", () => {
  const g = buildSymbolGraph([{ file: "a.ts", name: "foo", refs: ["foo"] }], "p");
  assert.equal(g.edges.length, 0);
});

test("buildMemoryGraph: link edges only for resolvable slugs", () => {
  const mems: MemoryRow[] = [
    { slug: "x", category: "decision", links: ["y", "ghost"] },
    { slug: "y", category: null, links: [] },
  ];
  const g = buildMemoryGraph(mems, "p");
  assert.equal(g.nodes.length, 2);
  assert.deepEqual(g.edges, [{ source: "mem:x", target: "mem:y", type: "link" }]);
});

test("buildProjectGraph: scope filters which sub-graphs are included", () => {
  const data = {
    symbols: [{ file: "a.ts", name: "foo", refs: [] }],
    memory: [{ slug: "x", links: [] }],
  };
  assert.equal(buildProjectGraph(data, "p", "symbols").nodes.length, 1);
  assert.equal(buildProjectGraph(data, "p", "memory").nodes.length, 1);
  assert.equal(buildProjectGraph(data, "p", "all").nodes.length, 2);
  // Unknown scope yields an empty graph (matches prior behaviour).
  assert.equal(buildProjectGraph(data, "p", "nope" as never).nodes.length, 0);
});

test("graphify: orchestrates fetch+build per project from a fake source", async () => {
  const fake: GraphSource = {
    listProjects: async () => ["p1", "p2"],
    symbols: async (p) => (p === "p1" ? [{ file: "a.ts", name: "foo", refs: [] }] : []),
    memory: async (p) => (p === "p1" ? [{ slug: "x", links: [] }] : []),
  };
  const all = await graphify(fake);
  assert.deepEqual(Object.keys(all), ["p1", "p2"]);
  assert.equal(all.p1.nodes.length, 2);
  assert.equal(all.p2.nodes.length, 0);

  const one = await graphify(fake, { project: "p1", scope: "symbols" });
  assert.deepEqual(Object.keys(one), ["p1"]);
  assert.equal(one.p1.nodes.length, 1);
});

test("graphToDot: stable digraph output", () => {
  const graphs = {
    p: { nodes: [{ id: "sym:a.ts::foo", label: "foo", kind: "symbol" as const, project: "p" }], edges: [] },
  };
  const dot = graphToDot(graphs);
  assert.ok(dot.startsWith("digraph aitl {"));
  assert.ok(dot.includes('"p::sym:a.ts::foo" [label="foo"];'));
});
