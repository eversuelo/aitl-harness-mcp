/**
 * MemoryStore — the single gateway to durable memory in MongoDB.
 *
 * Centralizes all reads/writes for the shared memory bank, transcripts, decisions
 * and the classification taxonomy. Provides:
 *   - upsert helpers for MemoryDoc / Message
 *   - semantic search via Atlas `$vectorSearch`
 *   - lexical search via the `$text` index (fallback)
 *   - shared write-back so all subagents read/write one bank (Pain point #4)
 *
 * Nothing outside this module and `src/db/` should touch the MongoDB driver directly.
 */

import type { Db, Document } from "mongodb";
import { getDb } from "../db/client.js";
import type { Event, MemoryDoc, Message } from "./schemas.js";

export class MemoryStore {
  readonly db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  // ── writes ───────────────────────────────────────────────────────────
  /** Insert/update a memory doc, keyed by (project, slug). */
  async upsertMemory(doc: MemoryDoc): Promise<string> {
    doc.updated_at = new Date();
    await this.db
      .collection("memory")
      .updateOne({ project: doc.project, slug: doc.slug }, { $set: doc }, { upsert: true });
    return doc.slug;
  }

  /** Append a transcript turn (shared write-back). */
  async appendMessage(msg: Message): Promise<void> {
    await this.db.collection("messages").insertOne(msg);
  }

  async logEvent(event: Event): Promise<void> {
    await this.db.collection("events").insertOne(event);
  }

  // ── semantic search (Atlas Vector Search) ────────────────────────────
  /**
   * Run a `$vectorSearch` over `collection.embedding`.
   * Works identically on local `mongodb-atlas-local` and cloud Atlas.
   */
  async vectorSearch(
    collection: string,
    queryEmbedding: number[],
    opts: { project?: string; category?: string; limit?: number; numCandidates?: number } = {},
  ): Promise<Document[]> {
    const { project, category, limit = 10, numCandidates = 200 } = opts;
    const filter: Record<string, unknown> = {};
    if (project !== undefined) filter.project = project;
    if (category !== undefined) filter.category = category;

    const vectorSearch: Record<string, unknown> = {
      index: "vector_index",
      path: "embedding",
      queryVector: queryEmbedding,
      numCandidates,
      limit,
    };
    if (Object.keys(filter).length) vectorSearch.filter = filter;

    const pipeline = [
      { $vectorSearch: vectorSearch },
      { $addFields: { score: { $meta: "vectorSearchScore" } } },
      { $project: { embedding: 0 } },
    ];
    return this.db.collection(collection).aggregate(pipeline).toArray();
  }

  // ── lexical search (fallback) ────────────────────────────────────────
  async textSearch(
    collection: string,
    query: string,
    opts: { project?: string; limit?: number } = {},
  ): Promise<Document[]> {
    const { project, limit = 10 } = opts;
    const filter: Record<string, unknown> = { $text: { $search: query } };
    if (project !== undefined) filter.project = project;
    return this.db
      .collection(collection)
      .find(filter, { projection: { score: { $meta: "textScore" }, embedding: 0 } })
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .toArray();
  }

  // ── stats (used by the synthesizer trigger) ──────────────────────────
  async memoryDocCount(project: string): Promise<number> {
    return this.db.collection("memory").countDocuments({ project });
  }

  /** Rough token estimate (~4 chars/token) over a project's memory bodies. */
  async memoryTokenEstimate(project: string): Promise<number> {
    const agg = await this.db
      .collection("memory")
      .aggregate([
        { $match: { project } },
        { $group: { _id: null, chars: { $sum: { $strLenCP: { $ifNull: ["$body", ""] } } } } },
      ])
      .toArray();
    const chars = agg.length ? (agg[0].chars as number) : 0;
    return Math.floor(chars / 4);
  }

  async iterMemory(project: string, opts: { category?: string } = {}): Promise<Document[]> {
    const filter: Record<string, unknown> = { project };
    if (opts.category !== undefined) filter.category = opts.category;
    return this.db.collection("memory").find(filter).toArray();
  }

  // ── single-doc reads/deletes (used by the memory-admin UI/API) ───────────
  /** Fetch one memory doc by (project, slug); `null` if absent. Strips the vector. */
  async getMemory(project: string, slug: string): Promise<Document | null> {
    return this.db
      .collection("memory")
      .findOne({ project, slug }, { projection: { embedding: 0 } });
  }

  /** List a project's memory (no embeddings), newest first. */
  async listMemory(
    project: string,
    opts: { category?: string; type?: string; limit?: number } = {},
  ): Promise<Document[]> {
    const filter: Record<string, unknown> = { project };
    if (opts.category !== undefined) filter.category = opts.category;
    if (opts.type !== undefined) filter.type = opts.type;
    return this.db
      .collection("memory")
      .find(filter, { projection: { embedding: 0 } })
      .sort({ updated_at: -1 })
      .limit(opts.limit ?? 200)
      .toArray();
  }

  /** Delete one memory doc by (project, slug). Returns whether a doc was removed. */
  async deleteMemory(project: string, slug: string): Promise<boolean> {
    const res = await this.db.collection("memory").deleteOne({ project, slug });
    return res.deletedCount === 1;
  }

  /** Distinct project names that have at least one memory doc. */
  async listProjects(): Promise<string[]> {
    const names = await this.db.collection("memory").distinct("project");
    return names.filter((n): n is string => typeof n === "string" && n.length > 0).sort();
  }
}
