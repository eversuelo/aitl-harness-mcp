/**
 * Pure serializers — graph(s) in, string out. No I/O.
 */

import type { Graph } from "./types.js";

type GraphLike = Pick<Graph, "nodes" | "edges">;

/** Render per-project graphs as a Graphviz DOT digraph (one cluster per project). */
export function graphToDot(perProject: Record<string, GraphLike>): string {
  const lines = ["digraph aitl {", "  rankdir=LR; node [shape=box];"];
  for (const [proj, g] of Object.entries(perProject)) {
    lines.push(`  subgraph "cluster_${proj}" { label="${proj}";`);
    for (const n of g.nodes) lines.push(`    "${proj}::${n.id}" [label="${n.label}"];`);
    lines.push("  }");
    for (const e of g.edges) lines.push(`  "${proj}::${e.source}" -> "${proj}::${e.target}";`);
  }
  lines.push("}");
  return lines.join("\n");
}
