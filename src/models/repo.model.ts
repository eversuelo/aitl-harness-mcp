/**
 * Mongoose model for the `repos` collection (ADR-0028).
 *
 * A `repo` is the leaf of `software -> projects -> repos`: a concrete git repository
 * (remote/branch/path) that belongs to a `project` scope. Keyed by (project, name).
 * The same `name` is used as the data sub-scope `repo` on memory/symbols/context.
 *
 * Replaces the former Zod `RepoRecordSchema`: Mongoose is now the single source of
 * shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with
 * the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const REPOS_COLLECTION = "repos";

const now = () => new Date();

const repoSchema = new Schema(
  {
    project: { type: String, required: true }, // owning project scope
    name: { type: String, required: true }, // repo key within the project (also the data sub-scope `repo`)
    software: { type: String, default: null }, // owning software name (optional)
    remote: { type: String, default: "" }, // git remote URL
    branch: { type: String, default: "" },
    path: { type: String, default: "" }, // local filesystem root, if any
    description: { type: String, default: "" },
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: REPOS_COLLECTION },
);

export type RepoRecord = InferSchemaType<typeof repoSchema>;

export const RepoModel = model("Repo", repoSchema);

/** Build + validate a repo record (fills schema defaults). Mirrors the former Zod builder. */
export const makeRepoRecord = (v: Partial<RepoRecord> & { project: string; name: string }): RepoRecord => {
  const doc = new RepoModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as RepoRecord & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
