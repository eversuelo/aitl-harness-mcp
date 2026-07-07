/**
 * DefinitionStore — gateway to the `agents` / `skills` collections.
 *
 * One store class serves either collection (chosen by `kind`), since both hold the
 * same `DefinitionRecord` shape. Migrated to the Mongoose `AgentModel`/`SkillModel`
 * (picked by `modelFor`). Upsert is keyed by (project, name); search uses Mongo
 * `$text` with a case-insensitive regex fallback (mirrors PromptStore), so it works
 * on any deployment without a vector index.
 */

import type { Model } from "mongoose";
import { ensureMongoose } from "../db/mongoose.js";
import {
  type DefinitionKind,
  type DefinitionRecord,
  collectionFor,
  makeDefinitionRecord,
  modelFor,
} from "../models/definition.model.js";

export class DefinitionStore {
  readonly model: Model<DefinitionRecord>;
  readonly collection: string;

  constructor(kind: DefinitionKind) {
    this.model = modelFor(kind) as unknown as Model<DefinitionRecord>;
    this.collection = collectionFor(kind);
  }

  /** Insert/update a definition, keyed by (project, name). Returns the stored record. */
  async upsert(
    rec: Partial<DefinitionRecord> & { project: string; name: string },
  ): Promise<DefinitionRecord> {
    await ensureMongoose();
    const doc = await makeDefinitionRecord(rec);
    doc.updated_at = new Date();
    const existing = await this.model
      .findOne({ project: doc.project, name: doc.name }, { created_at: 1 })
      .lean<DefinitionRecord>();
    if (existing?.created_at instanceof Date) doc.created_at = existing.created_at;
    await this.model.updateOne(
      { project: doc.project, name: doc.name },
      { $set: doc },
      { upsert: true },
    );
    return doc;
  }

  /** Fetch one definition by (project, name); `null` if absent. */
  async get(project: string, name: string): Promise<DefinitionRecord | null> {
    await ensureMongoose();
    return this.model.findOne({ project, name }).lean<DefinitionRecord>();
  }

  /** List a project's definitions, newest first. Optional tag filter. */
  async list(
    project: string,
    opts: { tag?: string; limit?: number } = {},
  ): Promise<DefinitionRecord[]> {
    await ensureMongoose();
    const query: Record<string, unknown> = { project };
    if (opts.tag !== undefined) query.tags = opts.tag;
    return this.model
      .find(query)
      .sort({ updated_at: -1 })
      .limit(opts.limit ?? 100)
      .lean<DefinitionRecord[]>();
  }

  /** Search definitions: Mongo `$text` with a case-insensitive regex fallback. */
  async search(project: string, query: string, limit = 10): Promise<DefinitionRecord[]> {
    await ensureMongoose();
    try {
      return await this.model
        .find(
          { project, $text: { $search: query } },
          { score: { $meta: "textScore" } },
        )
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .lean<DefinitionRecord[]>();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return this.model
        .find({ project, $or: [{ name: rx }, { description: rx }, { content: rx }] })
        .sort({ updated_at: -1 })
        .limit(limit)
        .lean<DefinitionRecord[]>();
    }
  }

  /** Delete one definition by (project, name). Returns whether a doc was removed. */
  async delete(project: string, name: string): Promise<boolean> {
    await ensureMongoose();
    const res = await this.model.deleteOne({ project, name });
    return res.deletedCount === 1;
  }
}
