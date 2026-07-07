/**
 * Mongoose model for the `categories` collection.
 *
 * A `category` is a per-project classification taxonomy node (for memory/chat
 * classification).
 *
 * Replaces the former Zod `CategorySchema`: Mongoose is now the single source of shape +
 * validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the
 * pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const CATEGORIES_COLLECTION = "categories";

const now = () => new Date();

const categorySchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    name: { type: String, required: true },
    kind: { type: String, enum: ["memory", "chat"], required: true },
    description: { type: String, default: "" },
    rules: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: CATEGORIES_COLLECTION },
);

export type Category = InferSchemaType<typeof categorySchema>;

export const CategoryModel = model("Category", categorySchema);

/** Build + validate a category (fills schema defaults). Mirrors the former Zod builder. */
export const makeCategory = async (v: Partial<Category> & { project: string; name: string; kind: "memory" | "chat" }): Promise<Category> => {
  const doc = new CategoryModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as Category & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
