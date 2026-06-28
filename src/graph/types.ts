/**
 * Pure value types for the durable-state graph projection.
 *
 * This module has NO I/O and NO dependency on MongoDB — it is the pure core of
 * `graphify`. Data comes in (symbol/memory rows), a graph comes out. The Mongo
 * wiring lives behind the `GraphSource` port (see `source.ts`).
 */

export type Scope = "all" | "symbols" | "memory";

export interface GraphNode {
  id: string;
  label: string;
  kind: "symbol" | "memory";
  project: string;
  /** symbol nodes carry `file`/`pagerank`; memory nodes carry `category`. */
  [k: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "ref" | "link";
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Minimal shape of a `symbols` document the graph builder consumes. */
export interface SymbolRow {
  file?: string;
  name?: string;
  refs?: string[];
  pagerank?: number;
  [k: string]: unknown;
}

/** Minimal shape of a `memory` document the graph builder consumes. */
export interface MemoryRow {
  slug?: string;
  category?: string | null;
  links?: string[];
  [k: string]: unknown;
}

/** Cheap node/edge counts for a graph (used by callers for summaries). */
export const counts = (g: Graph): { nodes: number; edges: number } => ({
  nodes: g.nodes.length,
  edges: g.edges.length,
});
