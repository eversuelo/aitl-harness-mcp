/**
 * Mongoose model for the `conventions` collection.
 *
 * A `convention` is a parsed convention/pattern rule (Pain Point #3): an explicit,
 * durable record hooks can enforce as gates. Written by `conventions/loader.ts` from
 * AGENTS.md; read during hydration.
 *
 * Replaces the former Zod `ConventionSchema`: Mongoose is now the single source of
 * shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with
 * the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const CONVENTIONS_COLLECTION = "conventions";

const now = () => new Date();

const conventionSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    scope_glob: { type: String, default: "**/*" },
    rule: { type: String, default: "" },
    severity: { type: String, enum: ["info", "warn", "error"], default: "warn" },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: CONVENTIONS_COLLECTION },
);

export type Convention = InferSchemaType<typeof conventionSchema>;

export const ConventionModel = model("Convention", conventionSchema);

/** Build + validate a convention (fills schema defaults). Mirrors the former Zod builder. */
export const makeConvention = async (v: Partial<Convention> & { project: string }): Promise<Convention> => {
  const doc = new ConventionModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as Convention & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
