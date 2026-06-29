/**
 * Pure value types for the durable-state graph projection.
 *
 * This module has NO I/O and NO dependency on MongoDB — it is the pure core of
 * `graphify`. Data comes in (symbol/memory rows), a graph comes out. The Mongo
 * wiring lives behind the `GraphSource` port (see `source.ts`).
 */

export type Scope = "all" | "symbols" | "memory";

/**
 * Entity kinds a node can represent (ADR-0029 knowledge map; ADR-0031 adds `branch`;
 * ADR-0035 adds `run`/`prompt` for the per-session graph).
 */
export type NodeKind =
  | "symbol"
  | "memory"
  | "decision"
  | "context"
  | "software"
  | "project"
  | "repo"
  | "branch"
  | "run"
  | "prompt";

/**
 * Edge kinds (ADR-0029 `contains`/`references`; ADR-0031 `derives` for branch graph;
 * ADR-0035 `produced` linking a run to the artifacts written during its session).
 */
export type EdgeKind = "ref" | "link" | "contains" | "references" | "derives" | "produced";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  project: string;
  /** symbol nodes carry `file`/`pagerank`; memory nodes carry `category`; etc. */
  [k: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeKind;
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
  repo?: string | null;
  [k: string]: unknown;
}

/** Minimal shapes for the knowledge-map entities (ADR-0029). */
export interface DecisionRow {
  id?: string;
  title?: string;
  status?: string;
  context?: string;
  decision?: string;
  consequences?: string;
  repo?: string | null;
  [k: string]: unknown;
}
export interface ContextRow {
  context_id?: string;
  title?: string;
  repo?: string | null;
  run_id?: string | null;
  [k: string]: unknown;
}
export interface SoftwareRow {
  name?: string;
  display_name?: string;
  projects?: string[];
  [k: string]: unknown;
}
export interface RepoRow {
  name?: string;
  project?: string;
  software?: string | null;
  [k: string]: unknown;
}
export interface BranchRow {
  name?: string;
  repo?: string;
  kind?: string;
  environment?: string;
  base?: string | null;
  [k: string]: unknown;
}

/** Cheap node/edge counts for a graph (used by callers for summaries). */
export const counts = (g: Graph): { nodes: number; edges: number } => ({
  nodes: g.nodes.length,
  edges: g.edges.length,
});
