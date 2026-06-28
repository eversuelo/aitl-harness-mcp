/**
 * Graph module — project the durable state (symbols + memory) as a directed graph.
 *
 * Decoupled into: pure builders (`build.ts`) + pure serializers (`serialize.ts`)
 * + a `GraphSource` port (`source.ts`). `graphify()` is a thin orchestrator that
 * wires fetch → build, with no serialization concern. The MCP tool, CLI and HTTP
 * API all reuse this same core; the pure pieces are testable without a database.
 */

import { buildProjectGraph } from "./build.js";
import { KNOWLEDGE_ENTITIES, buildKnowledgeGraph } from "./knowledge.js";
import type { GraphSource } from "./source.js";
import type { Graph, NodeKind, Scope } from "./types.js";

export * from "./types.js";
export * from "./build.js";
export * from "./knowledge.js";
export * from "./serialize.js";
export { MongoGraphSource } from "./source.js";
export type { GraphSource } from "./source.js";

/**
 * Build per-project graphs from a source. Fetch (impure, via the port) + build
 * (pure). Returns `{ [project]: Graph }`; serialization is the caller's choice.
 */
export async function graphify(
  source: GraphSource,
  opts: { project?: string; scope?: Scope } = {},
): Promise<Record<string, Graph>> {
  const projects = opts.project ? [opts.project] : await source.listProjects();
  const out: Record<string, Graph> = {};
  for (const p of projects) {
    const [symbols, memory] = await Promise.all([source.symbols(p), source.memory(p)]);
    out[p] = buildProjectGraph({ symbols, memory }, p, opts.scope ?? "all");
  }
  return out;
}

/**
 * Build the multi-entity knowledge map for ONE project (ADR-0029): software →
 * project → repo → {memory, decision, symbol, context}. `entities` selects which
 * kinds to fetch/include; symbols are excluded by default (large; in the Graph tab).
 */
export async function knowledgeGraphify(
  source: GraphSource,
  opts: { project: string; entities?: NodeKind[] },
): Promise<Graph> {
  const include = opts.entities ?? KNOWLEDGE_ENTITIES.filter((k) => k !== "symbol");
  const want = new Set(include);
  const p = opts.project;
  const [symbols, memory, decisions, context, softwares, repos] = await Promise.all([
    want.has("symbol") ? source.symbols(p) : Promise.resolve([]),
    want.has("memory") ? source.memory(p) : Promise.resolve([]),
    want.has("decision") ? source.decisions(p) : Promise.resolve([]),
    want.has("context") ? source.context(p) : Promise.resolve([]),
    want.has("software") ? source.softwares(p) : Promise.resolve([]),
    want.has("repo") ? source.repos(p) : Promise.resolve([]),
  ]);
  return buildKnowledgeGraph({ symbols, memory, decisions, context, softwares, repos }, p, include);
}
