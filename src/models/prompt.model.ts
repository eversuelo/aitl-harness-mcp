/**
 * Mongoose model for the durable prompt history (`prompts` collection).
 *
 * Shares the `prompts` collection with the MCP server's record_prompt/list_prompts/
 * search_prompts tools (same document shape), so the CLI and the MCP read/write the
 * SAME history. Keyed by Mongo's default ObjectId `_id` (NOT a natural key).
 *
 * Replaces the former Zod `PromptRecordSchema`: Mongoose is now the single source of
 * shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with
 * the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const PROMPT_COLLECTION = "prompts";

const promptSchema = new Schema(
  {
    project: { type: String, required: true },
    prompt: { type: String, required: true },
    title: { type: String, default: "" },
    source: { type: String, default: "cli" }, // cli | mcp | ui | …
    actor_id: { type: String, default: null }, // who issued it (RBAC actor)
    owner_user: { type: String, default: null }, // username that owns this prompt
    model: { type: String, default: null },
    run_id: { type: String, default: null },
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: () => new Date() },
  },
  { ...BASE_SCHEMA_OPTS, collection: PROMPT_COLLECTION },
);

export type PromptRecord = InferSchemaType<typeof promptSchema>;

export const PromptModel = model("Prompt", promptSchema);

/** Build + validate a prompt record (fills schema defaults). Mirrors the former Zod builder. */
export const makePromptRecord = (v: Partial<PromptRecord> & { project: string; prompt: string }): PromptRecord => {
  const doc = new PromptModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as PromptRecord & { _id?: unknown };
  delete obj._id; // Mongo assigns a fresh _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
