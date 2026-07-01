/**
 * PromptStore — gateway to the durable prompt history (`prompts` collection).
 *
 * Write/read shape matches the MCP server's record_prompt/list_prompts/search_prompts
 * tools so the CLI and the MCP interoperate on one history. Migrated to the Mongoose
 * `PromptModel`; prompts are keyed by Mongo's default ObjectId `_id`.
 */

import { ensureMongoose, mongoose } from "../db/mongoose.js";
import { PromptModel, type PromptRecord, makePromptRecord } from "../models/prompt.model.js";

export class PromptStore {
  /** Append a prompt to the history. Returns the stored record + inserted id. */
  async add(
    rec: Partial<PromptRecord> & { project: string; prompt: string },
  ): Promise<PromptRecord & { id: string }> {
    await ensureMongoose();
    const d = await PromptModel.create(makePromptRecord(rec));
    return { ...d.toObject(), id: String(d._id) };
  }

  /** List prompts for a project, newest first. Optional source/tag filters. */
  async list(
    project: string,
    opts: { source?: string; tag?: string; limit?: number } = {},
  ): Promise<PromptRecord[]> {
    await ensureMongoose();
    const query: Record<string, unknown> = { project };
    if (opts.source !== undefined) query.source = opts.source;
    if (opts.tag !== undefined) query.tags = opts.tag;
    return PromptModel.find(query).sort({ created_at: -1 }).limit(opts.limit ?? 50).lean<PromptRecord[]>();
  }

  /** Fetch a single prompt by its stored ObjectId string, or null if not found/invalid. */
  async getById(id: string): Promise<(PromptRecord & { owner_user?: string | null }) | null> {
    await ensureMongoose();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return PromptModel.findById(id).lean<PromptRecord>();
  }

  /** Delete a prompt by id. Returns whether a document was removed. */
  async deleteById(id: string): Promise<boolean> {
    await ensureMongoose();
    if (!mongoose.Types.ObjectId.isValid(id)) return false;
    const res = await PromptModel.findByIdAndDelete(id);
    return res !== null;
  }

  /** Search the prompt history: Mongo `$text` with a case-insensitive regex fallback. */
  async search(project: string, query: string, limit = 10): Promise<PromptRecord[]> {
    await ensureMongoose();
    try {
      return await PromptModel.find({ project, $text: { $search: query } }, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .lean<PromptRecord[]>();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return PromptModel.find({ project, $or: [{ prompt: rx }, { title: rx }] })
        .sort({ created_at: -1 })
        .limit(limit)
        .lean<PromptRecord[]>();
    }
  }
}
