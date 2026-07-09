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
  "approval",
  "synthesis",
  "hydrate",
  "session_summary",
  "skills_route",
  "retry",
  "verify",
  // loop engineering (ADR-0062): no-progress strikes, budget breaches, post-verify
  // reflection turns — distinct outcomes the stability metrics need to tell apart.
  "stall",
  "budget",
  "reflection",
  // caller abort (ESC in the chat REPL): the run ended `interrupted`, resumable.
  "interrupt",
  "error",
  "resume",
  "spawn",
  "mcp_connect",
  "review",
  "role_veto",
  "deliberation",
  "human_intervention",
  // plan-council (ADR-0003 v1): one event per client/round + the judge's verdict.
  "council_propose",
  "council_critique",
  "council_no_vote",
  "council_verdict",
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
export const makeEvent = async (v: Partial<Event> & { project: string; type: Event["type"] }): Promise<Event> => {
  const doc = new EventModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as Event & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
