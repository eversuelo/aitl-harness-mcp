/**
 * SoftwareStore — gateway to the `softwares` collection (ADR-0028).
 * Keyed globally by `name`. Mirrors DefinitionStore (upsert/get/list/search/delete)
 * but without project scoping, since a software spans projects.
 */

import type { Db, Document } from "mongodb";
import { getDb } from "../db/client.js";
import { SOFTWARES_COLLECTION, type SoftwareRecord, makeSoftwareRecord } from "./schemas.js";

export class SoftwareStore {
  readonly db: Db;
  readonly collection = SOFTWARES_COLLECTION;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /** Insert/update a software, keyed by `name`. Preserves created_at. */
  async upsert(rec: Partial<SoftwareRecord> & { name: string }): Promise<SoftwareRecord> {
    const doc = makeSoftwareRecord(rec);
    doc.updated_at = new Date();
    const existing = await this.db.collection(this.collection).findOne({ name: doc.name }, { projection: { created_at: 1 } });
    if (existing?.created_at instanceof Date) doc.created_at = existing.created_at;
    await this.db.collection(this.collection).updateOne({ name: doc.name }, { $set: doc }, { upsert: true });
    return doc;
  }

  async get(name: string): Promise<Document | null> {
    return this.db.collection(this.collection).findOne({ name });
  }

  async list(opts: { tag?: string; limit?: number } = {}): Promise<Document[]> {
    const query: Record<string, unknown> = {};
    if (opts.tag !== undefined) query.tags = opts.tag;
    return this.db.collection(this.collection).find(query).sort({ updated_at: -1 }).limit(opts.limit ?? 100).toArray();
  }

  async search(query: string, limit = 10): Promise<Document[]> {
    const coll = this.db.collection(this.collection);
    try {
      return await coll
        .find({ $text: { $search: query } }, { projection: { score: { $meta: "textScore" } } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .toArray();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return coll
        .find({ $or: [{ name: rx }, { display_name: rx }, { description: rx }] })
        .sort({ updated_at: -1 })
        .limit(limit)
        .toArray();
    }
  }

  async delete(name: string): Promise<boolean> {
    const res = await this.db.collection(this.collection).deleteOne({ name });
    return res.deletedCount === 1;
  }
}
