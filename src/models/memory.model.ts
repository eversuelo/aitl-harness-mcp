/**
 * Mongoose model for the `memory` collection — a markdown memory file or shared-bank entry.
 *
 * MemoryDocs are the durable, structured project memory (the shared bank, Pain point #4):
 * decisions, conventions, notes and session summaries, retrievable via Atlas `$vectorSearch`,
 * `$text`, or recency. Keyed by (project, slug). `version` is bumped on each content change
 * (prior versions archived append-only in `memory_history`, ADR-0027). `embedding` is set by
 * the embedder on write and stripped only on the documented read projections.
 *
 * Extracted from the shared Zod `MemoryDocSchema` (memory/schemas.ts): Mongoose is now the
 * single source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents
 * byte-compatible with the pre-migration driver-written docs (no `__v`, no auto timestamps,
 * empty `{}` `frontmatter` preserved via minimize:false).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";
import { MEMORY_TYPES } from "../memory/schemas.js";

export const MEMORY_COLLECTION = "memory";

const now = () => new Date();

const memoryDocSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
    slug: { type: String, required: true },
    repo: { type: String, default: null }, // repo sub-scope within the project (ADR-0028)
    type: { type: String, enum: MEMORY_TYPES, default: "project" },
    description: { type: String, default: "" },
    body: { type: String, default: "" },
    frontmatter: { type: Schema.Types.Mixed, default: () => ({}) },
    links: { type: [String], default: [] }, // [[other-slug]] references
    source_path: { type: String, default: null },
    category: { type: String, default: null },
    tags: { type: [String], default: [] },
    version: { type: Number, default: 1 }, // bumped on each content change; history in memory_history
    actor_id: { type: String, default: null }, // who authored the current version (provenance)
    actor_role: { type: String, default: null },
    branch: { type: String, default: null }, // git branch this version was authored on (ADR-0028)
    embedding: { type: [Number], default: null },
  },
  { ...BASE_SCHEMA_OPTS, collection: MEMORY_COLLECTION },
);

export type MemoryDoc = InferSchemaType<typeof memoryDocSchema>;

export const MemoryModel = model("Memory", memoryDocSchema);

/** Build + validate a memory doc (fills schema defaults). Mirrors the former Zod builder. */
export const makeMemoryDoc = async (v: Partial<MemoryDoc> & { project: string; slug: string }): Promise<MemoryDoc> => {
  const doc = new MemoryModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as MemoryDoc & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
