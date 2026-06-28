/**
 * GraphSource — the port that feeds the pure graph builders.
 *
 * This is the ONLY impure edge of the graph module: everything else (build,
 * serialize) is a pure function. Swap `MongoGraphSource` for an in-memory fake
 * in tests, or for an HTTP-backed source in the UI, without touching the graph
 * logic — same hexagonal pattern the core uses for `Provider`/`MemoryStore`.
 */

import type { Db } from "mongodb";
import type { ContextRow, DecisionRow, MemoryRow, RepoRow, SoftwareRow, SymbolRow } from "./types.js";

export interface GraphSource {
  /** Distinct projects that have durable state worth graphing. */
  listProjects(): Promise<string[]>;
  /** `symbols` rows for a project (embedding stripped). */
  symbols(project: string): Promise<SymbolRow[]>;
  /** `memory` rows for a project (embedding stripped). */
  memory(project: string): Promise<MemoryRow[]>;
  /** `decisions` (ADR) rows for a project (knowledge map, ADR-0029). */
  decisions(project: string): Promise<DecisionRow[]>;
  /** `mcp_context` snapshot rows for a project (lightweight). */
  context(project: string): Promise<ContextRow[]>;
  /** `softwares` whose `projects` include this project. */
  softwares(project: string): Promise<SoftwareRow[]>;
  /** `repos` belonging to a project. */
  repos(project: string): Promise<RepoRow[]>;
}

/** MongoDB-backed source. Reads symbols/memory and discovers projects. */
export class MongoGraphSource implements GraphSource {
  constructor(private readonly db: Db) {}

  async listProjects(): Promise<string[]> {
    const names = new Set<string>();
    for (const coll of ["symbols", "memory", "decisions"]) {
      for (const n of await this.db.collection(coll).distinct("project")) if (n) names.add(String(n));
    }
    return [...names].sort();
  }

  async symbols(project: string): Promise<SymbolRow[]> {
    return this.db.collection("symbols").find({ project }, { projection: { embedding: 0 } }).toArray() as Promise<SymbolRow[]>;
  }

  async memory(project: string): Promise<MemoryRow[]> {
    return this.db.collection("memory").find({ project }, { projection: { embedding: 0 } }).toArray() as Promise<MemoryRow[]>;
  }

  async decisions(project: string): Promise<DecisionRow[]> {
    return this.db.collection("decisions").find({ project }, { projection: { embedding: 0 } }).toArray() as Promise<DecisionRow[]>;
  }

  async context(project: string): Promise<ContextRow[]> {
    return this.db
      .collection("mcp_context")
      .find({ project }, { projection: { messages: 0, context: 0, content_text: 0 } })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray() as Promise<ContextRow[]>;
  }

  async softwares(project: string): Promise<SoftwareRow[]> {
    return this.db.collection("softwares").find({ projects: project }).toArray() as Promise<SoftwareRow[]>;
  }

  async repos(project: string): Promise<RepoRow[]> {
    return this.db.collection("repos").find({ project }).toArray() as Promise<RepoRow[]>;
  }
}
