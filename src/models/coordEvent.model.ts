/**
 * Mongoose model for the `coord_events` collection — coordination events (ADR-0002 v1).
 *
 * The durable notification channel between agents sharing a project: claims, releases,
 * expired-claim reclaims, recorded decisions (ADRs), completed tasks and free-form
 * notes each append one document here. Consumers read it by POLLING (`pollEvents`,
 * MCP `poll_events`, CLI `aitl coord poll`) — change streams and webhooks from the
 * full ADR-0002 design are explicitly deferred to a later slice.
 *
 * Emission is best-effort by contract: a failed coord_event write must NEVER break
 * the primary operation that triggered it (see `src/coord/events.ts`).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const COORD_EVENTS_COLLECTION = "coord_events";

export const COORD_EVENT_TYPES = [
  "claim", // a task was claimed
  "release", // a claim was released (payload.outcome: done|abandoned)
  "expire_reclaim", // an expired claim was taken over by a new owner
  "decision", // an ADR was recorded (payload: { id, title })
  "task_done", // a task finished (announced by another subsystem)
  "note", // free-form coordination note
] as const;
export type CoordEventType = (typeof COORD_EVENT_TYPES)[number];

const now = () => new Date();

const coordEventSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project coordination.
    type: { type: String, enum: COORD_EVENT_TYPES, required: true },
    task_key: { type: String, default: null }, // Optional: the claim's task key (claim/release/reclaim).
    actor_id: { type: String, default: null }, // Who caused the event.
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: now }, // Poll cursor field (indexed asc in db/indexes.ts).
  },
  { ...BASE_SCHEMA_OPTS, collection: COORD_EVENTS_COLLECTION },
);

export type CoordEvent = InferSchemaType<typeof coordEventSchema>;

export const CoordEventModel = model("CoordEvent", coordEventSchema);

/** Build + validate a coordination event (fills schema defaults). Same technique as `makeEvent`. */
export const makeCoordEvent = async (
  v: Partial<CoordEvent> & { project: string; type: CoordEventType },
): Promise<CoordEvent> => {
  const doc = new CoordEventModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as CoordEvent & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the other builders
  return obj;
};
