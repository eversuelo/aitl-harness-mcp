/**
 * GraphSource — the port that feeds the pure graph builders.
 *
 * This is the ONLY impure edge of the graph module: everything else (build,
 * serialize) is a pure function. Swap `MongoGraphSource` for an in-memory fake
 * in tests, or for an HTTP-backed source in the UI, without touching the graph
 * logic — same hexagonal pattern the core uses for `Provider`/`MemoryStore`.
 */

import type { Db } from "mongodb";
import type { MemoryRow, SymbolRow } from "./types.js";

export interface GraphSource {
  /** Distinct projects that have durable state worth graphing. */
  listProjects(): Promise<string[]>;
  /** `symbols` rows for a project (embedding stripped). */
  symbols(project: string): Promise<SymbolRow[]>;
  /** `memory` rows for a project (embedding stripped). */
  memory(project: string): Promise<MemoryRow[]>;
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
}
