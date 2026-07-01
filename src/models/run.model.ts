/**
 * Mongoose model for the `runs` collection — one agent run / session.
 *
 * A `run` is the durable, first-class record of a single agent execution (native `runAgent`,
 * an orchestration, a host-driven session, or a captured human session): its model, status,
 * measured token totals, wall-clock span and tags. Loop steps append to `events`; transcript
 * turns append to `messages`; both link back by `run_id`.
 *
 * Extracted from the shared Zod `RunSchema` (memory/schemas.ts): Mongoose is now the single
 * source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible
 * with the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}`
 * preserved).
 *
 * CRUCIAL: `runs._id` is an APP-SUPPLIED UUID STRING (from `randomUUID()`), not an ObjectId.
 * `_id: { type: String }` disables Mongoose's automatic ObjectId generation so the caller's
 * UUID is stored verbatim (and read back as a `string`, never coerced to an ObjectId).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const RUNS_COLLECTION = "runs";

const now = () => new Date();

const tokenUsageSchema = new Schema(
  {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
  },
  { _id: false, ...BASE_SCHEMA_OPTS },
);

const runSchema = new Schema(
  {
    // App-supplied run UUID (String, NOT ObjectId): callers pass `_id` at write time.
    _id: { type: String },
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
    model: { type: String, required: true },
    harness_config: { type: Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: ["running", "done", "error"], default: "running" },
    token_usage: { type: tokenUsageSchema, default: () => ({ input: 0, output: 0 }) },
    started_at: { type: Date, default: now },
    ended_at: { type: Date, default: null },
    tags: { type: [String], default: [] },
  },
  // strict:false — runs carry dynamic telemetry written via $set (host_meta, iters,
  // gate_denials, tool_calls, artifacts, roles, spec, decision_blocked) that is not in the
  // base shape; keep it (matches the pre-migration raw-driver behaviour, else it is dropped).
  { ...BASE_SCHEMA_OPTS, collection: RUNS_COLLECTION, strict: false },
);

export type Run = InferSchemaType<typeof runSchema>;

export const RunModel = model("Run", runSchema);

/**
 * Build + validate a run (fills schema defaults). Mirrors the former Zod builder: callers
 * supply the run `_id` (UUID) SEPARATELY at write time, so the built record is `_id`-free.
 */
export const makeRun = (v: Partial<Run> & { project: string; model: string }): Run => {
  const doc = new RunModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as Run & { _id?: unknown };
  delete obj._id; // callers supply _id (the run UUID) separately at write time
  return obj;
};
