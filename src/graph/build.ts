/**
 * Pure graph builders — data in, graph out. No I/O.
 *
 * Mirrors the edge semantics the harness has always used:
 *   - symbols → directed `ref` edges following each symbol's `refs`
 *   - memory  → directed `link` edges following each doc's `[[wiki-links]]`
 */

import type { Graph, GraphEdge, GraphNode, MemoryRow, Scope, SymbolRow } from "./types.js";

/** Build the symbol sub-graph: nodes per definition, `ref` edges between them. */
export function buildSymbolGraph(symbols: SymbolRow[], project: string): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  // First occurrence of a name wins as the canonical ref target (matches prior behaviour).
  const byName = new Map<string, string>();
  for (const s of symbols) {
    const nid = `sym:${s.file}::${s.name}`;
    if (s.name != null && !byName.has(s.name)) byName.set(s.name, nid);
    nodes.push({ id: nid, label: String(s.name ?? ""), kind: "symbol", project, file: s.file, pagerank: Number(s.pagerank ?? 0) });
  }
  for (const s of symbols) {
    const src = `sym:${s.file}::${s.name}`;
    for (const ref of s.refs ?? []) {
      const tgt = byName.get(ref);
      if (tgt && tgt !== src) edges.push({ source: src, target: tgt, type: "ref" });
    }
  }
  return { nodes, edges };
}

/** Build the memory sub-graph: nodes per slug, `link` edges following resolved wiki-links. */
export function buildMemoryGraph(mems: MemoryRow[], project: string): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const slugs = new Set(mems.map((m) => m.slug).filter((s): s is string => Boolean(s)));
  for (const m of mems) nodes.push({ id: `mem:${m.slug}`, label: String(m.slug ?? ""), kind: "memory", project, category: m.category ?? null });
  for (const m of mems) {
    for (const link of m.links ?? []) {
      if (slugs.has(link)) edges.push({ source: `mem:${m.slug}`, target: `mem:${link}`, type: "link" });
    }
  }
  return { nodes, edges };
}

/** Merge the requested sub-graphs for one project into a single graph. */
export function buildProjectGraph(
  data: { symbols: SymbolRow[]; memory: MemoryRow[] },
  project: string,
  scope: Scope = "all",
): Graph {
  const out: Graph = { nodes: [], edges: [] };
  if (scope === "all" || scope === "symbols") {
    const g = buildSymbolGraph(data.symbols, project);
    out.nodes.push(...g.nodes);
    out.edges.push(...g.edges);
  }
  if (scope === "all" || scope === "memory") {
    const g = buildMemoryGraph(data.memory, project);
    out.nodes.push(...g.nodes);
    out.edges.push(...g.edges);
  }
  return out;
}
