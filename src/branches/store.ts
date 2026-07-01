/**
 * BranchStore — gateway to the `branches` collection (ADR-0031). Keyed by
 * (project, repo, name). Migrated to the Mongoose `BranchModel`.
 */

import { ensureMongoose } from "../db/mongoose.js";
import { BRANCHES_COLLECTION, BranchModel, type BranchRecord, makeBranchRecord } from "../models/branch.model.js";

export class BranchStore {
  readonly collection = BRANCHES_COLLECTION;

  async upsert(rec: Partial<BranchRecord> & { project: string; repo: string; name: string }): Promise<BranchRecord> {
    await ensureMongoose();
    const doc = makeBranchRecord(rec);
    doc.updated_at = new Date();
    const existing = await BranchModel.findOne(
      { project: doc.project, repo: doc.repo, name: doc.name },
      { created_at: 1 },
    ).lean();
    if (existing?.created_at instanceof Date) doc.created_at = existing.created_at;
    await BranchModel.updateOne(
      { project: doc.project, repo: doc.repo, name: doc.name },
      { $set: doc },
      { upsert: true },
    );
    return doc;
  }

  async get(project: string, repo: string, name: string): Promise<BranchRecord | null> {
    await ensureMongoose();
    return BranchModel.findOne({ project, repo, name }).lean<BranchRecord>();
  }

  async list(opts: { project?: string; repo?: string; kind?: string; limit?: number } = {}): Promise<BranchRecord[]> {
    await ensureMongoose();
    const query: Record<string, unknown> = {};
    if (opts.project !== undefined) query.project = opts.project;
    if (opts.repo !== undefined) query.repo = opts.repo;
    if (opts.kind !== undefined) query.kind = opts.kind;
    return BranchModel.find(query).sort({ updated_at: -1 }).limit(opts.limit ?? 200).lean<BranchRecord[]>();
  }

  async delete(project: string, repo: string, name: string): Promise<boolean> {
    await ensureMongoose();
    const res = await BranchModel.deleteOne({ project, repo, name });
    return res.deletedCount === 1;
  }
}
