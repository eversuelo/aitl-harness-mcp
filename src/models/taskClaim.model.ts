/**
 * Mongoose model for the `task_claims` collection — coordination claims (ADR-0002 v1).
 *
 * A claim declares "owner X is working on task Y of project P" so concurrent agents /
 * developers sharing the same durable store can detect overlap BEFORE colliding.
 * Claims ALWAYS expire (`expires_at`, heartbeat-extended): a crashed agent never holds
 * a task forever — an expired claim is reclaimable by anyone (emits `expire_reclaim`).
 *
 * Concurrency: exactly ONE active claim may exist per (project, task_key). That is
 * enforced by a partial unique index (`partialFilterExpression: { released: false }`,
 * see `src/db/indexes.ts`), so released claims accumulate as history while the active
 * slot stays unique — inserts racing for the slot lose with E11000.
 *
 * `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the other collections
 * (no `__v`, no auto timestamps — claimed_at/heartbeat_at stay app-managed).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const TASK_CLAIMS_COLLECTION = "task_claims";

const now = () => new Date();

const taskClaimSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project coordination.
    task_key: { type: String, required: true }, // Free-form key: SDD task slug, path, or short description.
    scope: { type: String, default: "" }, // Declared work scope (free text, e.g. "schoolar backend").
    owner_id: { type: String, required: true }, // Actor id holding the claim.
    claimed_at: { type: Date, default: now },
    heartbeat_at: { type: Date, default: now }, // Last liveness signal; renewed by heartbeat/re-claim.
    expires_at: { type: Date, required: true }, // Claims ALWAYS expire (TTL default 30 min, AITL_CLAIM_TTL_MS).
    released: { type: Boolean, default: false }, // true → slot freed (done/abandoned/expired-reclaim).
    released_at: { type: Date, default: null },
  },
  { ...BASE_SCHEMA_OPTS, collection: TASK_CLAIMS_COLLECTION },
);

export type TaskClaim = InferSchemaType<typeof taskClaimSchema>;

export const TaskClaimModel = model("TaskClaim", taskClaimSchema);

/** Build + validate a task claim (fills schema defaults). Same technique as `makeSessionDoc`. */
export const makeTaskClaim = async (
  v: Partial<TaskClaim> & { project: string; task_key: string; owner_id: string; expires_at: Date },
): Promise<TaskClaim> => {
  const doc = new TaskClaimModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as TaskClaim & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the other builders
  return obj;
};
