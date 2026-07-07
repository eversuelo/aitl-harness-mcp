/**
 * Mongoose model for the `softwares` collection (ADR-0028).
 *
 * A `software` is the top of the product hierarchy `software -> projects -> repos`,
 * grouping project scopes under a product name; keyed globally by `name` (not project-scoped).
 *
 * Replaces the former Zod `SoftwareRecordSchema`: Mongoose is now the single source of
 * shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the
 * pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const SOFTWARES_COLLECTION = "softwares";

const now = () => new Date();

const softwareSchema = new Schema(
  {
    name: { type: String, required: true }, // globally-unique product key, e.g. "schoolar"
    display_name: { type: String, default: "" },
    description: { type: String, default: "" },
    projects: { type: [String], default: [] }, // member project scopes
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: SOFTWARES_COLLECTION },
);

export type SoftwareRecord = InferSchemaType<typeof softwareSchema>;

export const SoftwareModel = model("Software", softwareSchema);

/** Build + validate a software record (fills schema defaults). Mirrors the former Zod builder. */
export const makeSoftwareRecord = async (v: Partial<SoftwareRecord> & { name: string }): Promise<SoftwareRecord> => {
  const doc = new SoftwareModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as SoftwareRecord & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
