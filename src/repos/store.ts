/**
 * RepoStore — gateway to the `repos` collection (ADR-0028). Keyed by (project, name).
 * Mirrors DefinitionStore (upsert/get/list/search/delete).
 */

import type { Db, Document } from "mongodb";
import { getDb } from "../db/client.js";
import { REPOS_COLLECTION, type RepoRecord, makeRepoRecord } from "./schemas.js";

export class RepoStore {
  readonly db: Db;
  readonly collection = REPOS_COLLECTION;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /** Insert/update a repo, keyed by (project, name). Preserves created_at. */
  async upsert(rec: Partial<RepoRecord> & { project: string; name: string }): Promise<RepoRecord> {
    const doc = makeRepoRecord(rec);
    doc.updated_at = new Date();
    const existing = await this.db
      .collection(this.collection)
      .findOne({ project: doc.project, name: doc.name }, { projection: { created_at: 1 } });
    if (existing?.created_at instanceof Date) doc.created_at = existing.created_at;
    await this.db
      .collection(this.collection)
      .updateOne({ project: doc.project, name: doc.name }, { $set: doc }, { upsert: true });
    return doc;
  }

  async get(project: string, name: string): Promise<Document | null> {
    return this.db.collection(this.collection).findOne({ project, name });
  }

  /** List repos for a project, or for a whole software (via `software`), newest first. */
  async list(opts: { project?: string; software?: string; tag?: string; limit?: number } = {}): Promise<Document[]> {
    const query: Record<string, unknown> = {};
    if (opts.project !== undefined) query.project = opts.project;
    if (opts.software !== undefined) query.software = opts.software;
    if (opts.tag !== undefined) query.tags = opts.tag;
    return this.db.collection(this.collection).find(query).sort({ updated_at: -1 }).limit(opts.limit ?? 100).toArray();
  }

  async search(project: string, query: string, limit = 10): Promise<Document[]> {
    const coll = this.db.collection(this.collection);
    try {
      return await coll
        .find({ project, $text: { $search: query } }, { projection: { score: { $meta: "textScore" } } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .toArray();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return coll
        .find({ project, $or: [{ name: rx }, { description: rx }, { remote: rx }] })
        .sort({ updated_at: -1 })
        .limit(limit)
        .toArray();
    }
  }

  async delete(project: string, name: string): Promise<boolean> {
    const res = await this.db.collection(this.collection).deleteOne({ project, name });
    return res.deletedCount === 1;
  }
}
