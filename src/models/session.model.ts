/**
 * Mongoose model for the `sessions` collection — web login sessions (P1 auth).
 *
 * One document per issued bearer token. Only the sha256 hex of the token is stored
 * (`token_hash`) — the plaintext token exists solely in the login response and the
 * client's storage, so a database leak never leaks usable credentials.
 *
 * `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the other collections
 * (no `__v`, no auto timestamps — created_at/last_seen_at stay app-managed).
 *
 * The TTL index on `expires_at` and the unique index on `token_hash` are NOT declared
 * here on purpose: they live in `src/db/indexes.ts` (created by `aitl init-db`), like
 * every other collection's indexes. Declaring them here too would duplicate index
 * management.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const SESSIONS_COLLECTION = "sessions";

const now = () => new Date();

const sessionSchema = new Schema(
  {
    token_hash: { type: String, required: true }, // sha256 hex of the bearer token — never the token itself
    user_id: { type: String, required: true },
    role: { type: String, required: true },
    created_at: { type: Date, default: now },
    expires_at: { type: Date, required: true },
    last_seen_at: { type: Date, default: now },
    source: { type: String, enum: ["web"], default: "web" },
  },
  { ...BASE_SCHEMA_OPTS, collection: SESSIONS_COLLECTION },
);

export type SessionDoc = InferSchemaType<typeof sessionSchema>;

export const SessionModel = model("Session", sessionSchema);

/** Build + validate a session doc (fills schema defaults). Same technique as `makeMemoryDoc`. */
export const makeSessionDoc = (
  v: Partial<SessionDoc> & { token_hash: string; user_id: string; role: string; expires_at: Date },
): SessionDoc => {
  const doc = new SessionModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as SessionDoc & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the other builders
  return obj;
};
