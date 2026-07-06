/**
 * SoftwareStore — gateway to the `softwares` collection (ADR-0028).
 * Keyed globally by `name`. Migrated to the Mongoose `SoftwareModel`.
 * Mirrors DefinitionStore (upsert/get/list/search/delete) but without project scoping.
 */

import { ensureMongoose } from "../db/mongoose.js";
import { SOFTWARES_COLLECTION, SoftwareModel, type SoftwareRecord, makeSoftwareRecord } from "../models/software.model.js";

export class SoftwareStore {
  readonly collection = SOFTWARES_COLLECTION;

  /** Insert/update a software, keyed by `name`. Preserves created_at. */
  async upsert(rec: Partial<SoftwareRecord> & { name: string }): Promise<SoftwareRecord> {
    await ensureMongoose();
    const doc = await makeSoftwareRecord(rec);
    doc.updated_at = new Date();
    const existing = await SoftwareModel.findOne({ name: doc.name }, { created_at: 1 }).lean();
    if (existing?.created_at instanceof Date) doc.created_at = existing.created_at;
    await SoftwareModel.updateOne({ name: doc.name }, { $set: doc }, { upsert: true });
    return doc;
  }

  async get(name: string): Promise<SoftwareRecord | null> {
    await ensureMongoose();
    return SoftwareModel.findOne({ name }).lean<SoftwareRecord>();
  }

  async list(opts: { tag?: string; limit?: number } = {}): Promise<SoftwareRecord[]> {
    await ensureMongoose();
    const query: Record<string, unknown> = {};
    if (opts.tag !== undefined) query.tags = opts.tag;
    return SoftwareModel.find(query).sort({ updated_at: -1 }).limit(opts.limit ?? 100).lean<SoftwareRecord[]>();
  }

  async search(query: string, limit = 10): Promise<SoftwareRecord[]> {
    await ensureMongoose();
    try {
      return await SoftwareModel.find({ $text: { $search: query } }, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .lean<SoftwareRecord[]>();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return SoftwareModel.find({ $or: [{ name: rx }, { display_name: rx }, { description: rx }] })
        .sort({ updated_at: -1 })
        .limit(limit)
        .lean<SoftwareRecord[]>();
    }
  }

  async delete(name: string): Promise<boolean> {
    await ensureMongoose();
    const res = await SoftwareModel.deleteOne({ name });
    return res.deletedCount === 1;
  }
}
