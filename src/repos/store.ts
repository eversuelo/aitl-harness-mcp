/**
 * RepoStore — gateway to the `repos` collection (ADR-0028). Keyed by (project, name).
 * Mirrors DefinitionStore (upsert/get/list/search/delete). Migrated to the Mongoose `RepoModel`.
 */

import { ensureMongoose } from "../db/mongoose.js";
import { REPOS_COLLECTION, RepoModel, type RepoRecord, makeRepoRecord } from "../models/repo.model.js";

export class RepoStore {
  readonly collection = REPOS_COLLECTION;

  /** Insert/update a repo, keyed by (project, name). Preserves created_at. */
  async upsert(rec: Partial<RepoRecord> & { project: string; name: string }): Promise<RepoRecord> {
    await ensureMongoose();
    const doc = makeRepoRecord(rec);
    doc.updated_at = new Date();
    const existing = await RepoModel.findOne({ project: doc.project, name: doc.name }, { created_at: 1 }).lean();
    if (existing?.created_at instanceof Date) doc.created_at = existing.created_at;
    await RepoModel.updateOne({ project: doc.project, name: doc.name }, { $set: doc }, { upsert: true });
    return doc;
  }

  async get(project: string, name: string): Promise<RepoRecord | null> {
    await ensureMongoose();
    return RepoModel.findOne({ project, name }).lean<RepoRecord>();
  }

  /** List repos for a project, or for a whole software (via `software`), newest first. */
  async list(opts: { project?: string; software?: string; tag?: string; limit?: number } = {}): Promise<RepoRecord[]> {
    await ensureMongoose();
    const query: Record<string, unknown> = {};
    if (opts.project !== undefined) query.project = opts.project;
    if (opts.software !== undefined) query.software = opts.software;
    if (opts.tag !== undefined) query.tags = opts.tag;
    return RepoModel.find(query).sort({ updated_at: -1 }).limit(opts.limit ?? 100).lean<RepoRecord[]>();
  }

  async search(project: string, query: string, limit = 10): Promise<RepoRecord[]> {
    await ensureMongoose();
    try {
      return await RepoModel.find({ project, $text: { $search: query } }, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .lean<RepoRecord[]>();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return RepoModel.find({ project, $or: [{ name: rx }, { description: rx }, { remote: rx }] })
        .sort({ updated_at: -1 })
        .limit(limit)
        .lean<RepoRecord[]>();
    }
  }

  async delete(project: string, name: string): Promise<boolean> {
    await ensureMongoose();
    const res = await RepoModel.deleteOne({ project, name });
    return res.deletedCount === 1;
  }
}
