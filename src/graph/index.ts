/**
 * Graph module — project the durable state (symbols + memory) as a directed graph.
 *
 * Decoupled into: pure builders (`build.ts`) + pure serializers (`serialize.ts`)
 * + a `GraphSource` port (`source.ts`). `graphify()` is a thin orchestrator that
 * wires fetch → build, with no serialization concern. The MCP tool, CLI and HTTP
 * API all reuse this same core; the pure pieces are testable without a database.
 */

import { buildProjectGraph } from "./build.js";
import type { GraphSource } from "./source.js";
import type { Graph, Scope } from "./types.js";

export * from "./types.js";
export * from "./build.js";
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
