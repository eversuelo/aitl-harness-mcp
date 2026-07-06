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
 * Post-Mongoose migration this routes through the models (memory→MemoryModel,
 * messages→MessageModel, events→EventModel, decisions→DecisionModel) instead of the raw
 * driver. Each entry method `await ensureMongoose()` first. The `db` getter is retained
 * (backed by the legacy driver client) so callers that still read sibling collections
 * (conventions, recency scans in lifecycle.ts, RepoMap) keep working during coexistence.
 */

import type { Db, Document } from "mongodb";
import type { Model, PipelineStage } from "mongoose";
import { getDb } from "../db/client.js";
import { ensureMongoose } from "../db/mongoose.js";
import { DecisionModel } from "../models/decision.model.js";
import { EventModel } from "../models/event.model.js";
import { MemoryModel } from "../models/memory.model.js";
import { MessageModel } from "../models/message.model.js";
import type { Event } from "../models/event.model.js";
import type { MemoryDoc } from "../models/memory.model.js";
import type { Message } from "../models/message.model.js";
import { currentBranch, headSha } from "../util/git.js";
import { MEMORY_CONTENT_FIELDS, type VersioningActor, archiveAndBumpVersion } from "./versioning.js";

/**
 * Map a collection-name argument to the model that backs it (vector/text search routing).
 * Returns a widened `Model<any>` so the caller resolves against a single call signature
 * (the three models are distinct generic types). VECTOR_COLLECTIONS = messages/memory/decisions.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional widening across three model generics
function modelForCollection(collection: string): Model<any> {
  switch (collection) {
    case "messages":
      return MessageModel as unknown as Model<any>;
    case "memory":
      return MemoryModel as unknown as Model<any>;
    case "decisions":
      return DecisionModel as unknown as Model<any>;
    default:
      throw new Error(`MemoryStore: no model registered for collection '${collection}'`);
  }
}

export class MemoryStore {
  private readonly _db: Db | null;

  constructor(db?: Db) {
    this._db = db ?? null;
  }

  /**
   * Db handle: the injected one (tests) or the shared Mongoose-owned connection.
   * Resolved lazily so `new MemoryStore()` works before the connection is open —
   * every entry method awaits `ensureMongoose()` before touching it.
   */
  get db(): Db {
    return this._db ?? getDb();
  }

  // ── writes ───────────────────────────────────────────────────────────
  /**
   * Insert/update a memory doc, keyed by (project, slug).
   *
   * Git provenance (F2) is resolved HERE so every surface (CLI, MCP, API) gets it for
   * free: when the caller does not pass `branch`/`commit_sha`, the current branch and
   * HEAD sha of the process cwd are stamped. Explicit values (including null) win.
   */
  async upsertMemory(
    doc: MemoryDoc,
    opts: { actor?: VersioningActor; branch?: string | null; commit_sha?: string | null } = {},
  ): Promise<string> {
    await ensureMongoose();
    doc.updated_at = new Date();
    const branch = opts.branch !== undefined ? opts.branch : currentBranch();
    const commitSha = opts.commit_sha !== undefined ? opts.commit_sha : headSha();
    // Archive the prior version (if content changed) and set doc.version BEFORE overwrite.
    await archiveAndBumpVersion({
      kind: "memory",
      query: { project: doc.project, slug: doc.slug },
      nextDoc: doc,
      contentFields: MEMORY_CONTENT_FIELDS,
      ref: doc.slug,
      actor: opts.actor,
      branch,
      commit_sha: commitSha,
    });
    await MemoryModel.updateOne({ project: doc.project, slug: doc.slug }, { $set: doc }, { upsert: true });
    return doc.slug;
  }

  /** Append a transcript turn (shared write-back). */
  async appendMessage(msg: Message): Promise<void> {
    await ensureMongoose();
    await MessageModel.create(msg);
  }

  async logEvent(event: Event): Promise<void> {
    await ensureMongoose();
    await EventModel.create(event);
  }

  /** Read a run's transcript in order (used to resume a run from its durable state). */
  async getMessages(runId: string): Promise<Document[]> {
    await ensureMongoose();
    return MessageModel.find({ run_id: runId }).sort({ idx: 1 }).lean() as unknown as Promise<Document[]>;
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
    await ensureMongoose();
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
    ] as unknown as PipelineStage[];
    return modelForCollection(collection).aggregate(pipeline) as unknown as Promise<Document[]>;
  }

  // ── lexical search (fallback) ────────────────────────────────────────
  async textSearch(
    collection: string,
    query: string,
    opts: { project?: string; limit?: number } = {},
  ): Promise<Document[]> {
    await ensureMongoose();
    const { project, limit = 10 } = opts;
    const filter: Record<string, unknown> = { $text: { $search: query } };
    if (project !== undefined) filter.project = project;
    return modelForCollection(collection)
      .find(filter, { score: { $meta: "textScore" }, embedding: 0 })
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .lean() as unknown as Promise<Document[]>;
  }

  // ── stats (used by the synthesizer trigger) ──────────────────────────
  async memoryDocCount(project: string): Promise<number> {
    await ensureMongoose();
    return MemoryModel.countDocuments({ project });
  }

  /** Rough token estimate (~4 chars/token) over a project's memory bodies. */
  async memoryTokenEstimate(project: string): Promise<number> {
    await ensureMongoose();
    const agg = (await MemoryModel.aggregate([
      { $match: { project } },
      { $group: { _id: null, chars: { $sum: { $strLenCP: { $ifNull: ["$body", ""] } } } } },
    ])) as { chars?: number }[];
    const chars = agg.length ? (agg[0].chars as number) : 0;
    return Math.floor(chars / 4);
  }

  async iterMemory(project: string, opts: { category?: string } = {}): Promise<Document[]> {
    await ensureMongoose();
    const filter: Record<string, unknown> = { project };
    if (opts.category !== undefined) filter.category = opts.category;
    return MemoryModel.find(filter).lean() as unknown as Promise<Document[]>;
  }

  // ── single-doc reads/deletes (used by the memory-admin UI/API) ───────────
  /** Fetch one memory doc by (project, slug); `null` if absent. Strips the vector. */
  async getMemory(project: string, slug: string): Promise<Document | null> {
    await ensureMongoose();
    return MemoryModel.findOne({ project, slug }, { embedding: 0 }).lean() as unknown as Promise<Document | null>;
  }

  /** List a project's memory (no embeddings), newest first. */
  async listMemory(
    project: string,
    opts: { category?: string; type?: string; limit?: number } = {},
  ): Promise<Document[]> {
    await ensureMongoose();
    const filter: Record<string, unknown> = { project };
    if (opts.category !== undefined) filter.category = opts.category;
    if (opts.type !== undefined) filter.type = opts.type;
    return MemoryModel.find(filter, { embedding: 0 })
      .sort({ updated_at: -1 })
      .limit(opts.limit ?? 200)
      .lean() as unknown as Promise<Document[]>;
  }

  /** Delete one memory doc by (project, slug). Returns whether a doc was removed. */
  async deleteMemory(project: string, slug: string): Promise<boolean> {
    await ensureMongoose();
    const res = await MemoryModel.deleteOne({ project, slug });
    return res.deletedCount === 1;
  }

  /** Distinct project names that have at least one memory doc. */
  async listProjects(): Promise<string[]> {
    await ensureMongoose();
    const names = await MemoryModel.distinct("project");
    return names.filter((n): n is string => typeof n === "string" && n.length > 0).sort();
  }
}
