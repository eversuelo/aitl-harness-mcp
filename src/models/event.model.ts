/**
 * Mongoose model for the `events` collection — a loop / harness event, for thesis analysis.
 *
 * Every notable step of a run (loop iteration, compaction, tool call, gate, synthesis,
 * hydrate, retry, verify, error, resume, spawn, review, role veto, deliberation, human
 * intervention…) appends one document here. Purely observational telemetry: never read back
 * into a run, only aggregated for the thesis metrics. `run_id` is nullable (some events are
 * project-scoped, not run-scoped).
 *
 * Extracted from the shared Zod `EventSchema` (memory/schemas.ts): Mongoose is now the single
 * source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible
 * with the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}`
 * `payload` preserved via minimize:false).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const EVENTS_COLLECTION = "events";

const now = () => new Date();

const EVENT_TYPES = [
  "loop_iter",
  "compaction",
  "tool_call",
  "tool_pre_hook",
  "tool_post_hook",
  "gate",
  "synthesis",
  "hydrate",
  "session_summary",
  "skills_route",
  "retry",
  "verify",
  "error",
  "resume",
  "spawn",
  "review",
  "role_veto",
  "deliberation",
  "human_intervention",
] as const;

const eventSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
    run_id: { type: String, default: null },
    type: { type: String, enum: EVENT_TYPES, required: true },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    ts: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: EVENTS_COLLECTION },
);

export type Event = InferSchemaType<typeof eventSchema>;

export const EventModel = model("Event", eventSchema);

/** Build + validate an event (fills schema defaults). Mirrors the former Zod builder. */
export const makeEvent = (v: Partial<Event> & { project: string; type: Event["type"] }): Event => {
  const doc = new EventModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as Event & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
