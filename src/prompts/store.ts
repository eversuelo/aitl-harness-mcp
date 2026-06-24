/**
 * PromptStore — gateway to the durable prompt history (`prompts` collection).
 *
 * Write/read shape matches the MCP server's record_prompt/list_prompts/search_prompts
 * tools so the CLI and the MCP interoperate on one history. Kept separate from
 * MemoryStore/COLLECTIONS to preserve parity.
 */

import type { Db, Document } from "mongodb";
import { getDb } from "../db/client.js";
import { PROMPT_COLLECTION, type PromptRecord, makePromptRecord } from "./schemas.js";

export class PromptStore {
  readonly db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /** Append a prompt to the history. Returns the stored record + inserted id. */
  async add(
    rec: Partial<PromptRecord> & { project: string; prompt: string },
  ): Promise<PromptRecord & { id: string }> {
    const doc = makePromptRecord(rec);
    const res = await this.db.collection(PROMPT_COLLECTION).insertOne(doc);
    return { ...doc, id: String(res.insertedId) };
  }

  /** List prompts for a project, newest first. Optional source/tag filters. */
  async list(
    project: string,
    opts: { source?: string; tag?: string; limit?: number } = {},
  ): Promise<Document[]> {
    const query: Record<string, unknown> = { project };
    if (opts.source !== undefined) query.source = opts.source;
    if (opts.tag !== undefined) query.tags = opts.tag;
    return this.db
      .collection(PROMPT_COLLECTION)
      .find(query)
      .sort({ created_at: -1 })
      .limit(opts.limit ?? 50)
      .toArray();
  }

  /** Search the prompt history: Mongo `$text` with a case-insensitive regex fallback. */
  async search(project: string, query: string, limit = 10): Promise<Document[]> {
    const coll = this.db.collection(PROMPT_COLLECTION);
    try {
      return await coll
        .find({ project, $text: { $search: query } }, { projection: { score: { $meta: "textScore" } } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .toArray();
    } catch {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return coll
        .find({ project, $or: [{ prompt: rx }, { title: rx }] })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
    }
  }
}
