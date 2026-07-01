/**
 * Mongoose model for the `branches` collection (ADR-0031).
 *
 * A `branch` belongs to a repo (software → projects → repos → branches) and carries its
 * classification (kind + environment) and its derivation parent (`base`) so a GitHub-style
 * branch graph can be drawn. Keyed by (project, repo, name).
 *
 * Replaces the former Zod `BranchRecordSchema`: Mongoose is now the single source of
 * shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with
 * the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";
import type { BranchEnv, BranchKind } from "../util/branches.js";

export const BRANCHES_COLLECTION = "branches";

export const BRANCH_KINDS = ["main", "master", "develop", "staging", "release", "hotfix", "feature", "other"] as const;
export const BRANCH_ENVS = ["prod", "staging", "dev", "none"] as const;

const now = () => new Date();

const branchSchema = new Schema(
  {
    project: { type: String, required: true },
    repo: { type: String, required: true }, // owning repo name
    name: { type: String, required: true }, // branch name
    kind: { type: String, enum: BRANCH_KINDS, default: "other" },
    environment: { type: String, enum: BRANCH_ENVS, default: "none" },
    /** The branch this one derives from (null for trunks like main/develop). */
    base: { type: String, default: null },
    protectedBranch: { type: Boolean, default: false },
    head_sha: { type: String, default: null },
    remote: { type: String, default: null },
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: BRANCHES_COLLECTION },
);

export type BranchRecord = InferSchemaType<typeof branchSchema>;

export const BranchModel = model("Branch", branchSchema);

/** Build + validate a branch record (fills schema defaults). Mirrors the former Zod builder. */
export const makeBranchRecord = (
  v: Partial<BranchRecord> & { project: string; repo: string; name: string },
): BranchRecord => {
  const doc = new BranchModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as BranchRecord & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};

// Re-export the classifier types for convenience.
export type { BranchEnv, BranchKind };
