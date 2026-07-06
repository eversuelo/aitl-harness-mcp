/**
 * Mongoose model(s) for the append-only revision history (ADR-0027) — the durable
 * `decisions_history` and `memory_history` collections.
 *
 * Before a live (decisions/memory) doc is overwritten with changed content, the PREVIOUS doc
 * is snapshotted here (embedding stripped) and the live doc's `version` is bumped. This is
 * append-only: history is never mutated, only queried by `loadVersionChain`. Both collections
 * share ONE document shape (`HistoryEntry`); only the collection differs (picked by `kind`
 * via `collectionFor`/`modelFor`).
 *
 * Extracted from the shared Zod `HistoryEntrySchema` (memory/schemas.ts): Mongoose is now the
 * single source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents
 * byte-compatible with the pre-migration driver-written docs (no `__v`, no auto timestamps,
 * empty `{}` preserved). Mongoose disallows binding one Schema instance to two models, so the
 * second model gets a `.clone()` of the schema (two-models-one-schema).
 */

import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const DECISIONS_HISTORY_COLLECTION = "decisions_history";
export const MEMORY_HISTORY_COLLECTION = "memory_history";
export type HistoryKind = "decision" | "memory";

export const collectionFor = (kind: HistoryKind): string =>
  kind === "decision" ? DECISIONS_HISTORY_COLLECTION : MEMORY_HISTORY_COLLECTION;

const now = () => new Date();

const historyEntrySchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
    kind: { type: String, enum: ["decision", "memory"], required: true },
    ref: { type: String, required: true }, // the ADR id ("0007") or memory slug
    version: { type: Number, required: true }, // the version number of the archived snapshot
    actor_id: { type: String, default: "system" },
    actor_role: { type: String, default: "system" },
    branch: { type: String, default: null }, // git branch the archived version was authored on
    commit_sha: { type: String, default: null }, // git commit the archived version was authored at (F2)
    snapshot: { type: Schema.Types.Mixed, required: true }, // the prior doc, without its embedding
    archived_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS }, // no single `collection`: two models bind the same shape to two collections
);

export type HistoryEntry = InferSchemaType<typeof historyEntrySchema>;

/**
 * TWO models over the SAME document shape — the 3rd `model()` arg forces the collection
 * name so `decisions_history` and `memory_history` stay separate. Mongoose disallows binding
 * one Schema instance to two models, so the second model gets a clone of the schema.
 */
export const DecisionHistoryModel = model("DecisionHistory", historyEntrySchema, DECISIONS_HISTORY_COLLECTION);
export const MemoryHistoryModel = model("MemoryHistory", historyEntrySchema.clone(), MEMORY_HISTORY_COLLECTION);

/**
 * Pick the model backing a kind's history collection (used by versioning/history). Widened
 * to `Model<any>` so the union of the two distinct model generics resolves against a single
 * call signature at the call sites.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional widening across two model generics
export const modelFor = (kind: HistoryKind): Model<any> =>
  (kind === "decision" ? DecisionHistoryModel : MemoryHistoryModel) as unknown as Model<any>;

/** Build + validate a history entry (fills schema defaults). Mirrors the former Zod builder. */
export const makeHistoryEntry = async (
  v: Partial<HistoryEntry> & { project: string; kind: HistoryEntry["kind"]; ref: string; version: number; snapshot: unknown },
): Promise<HistoryEntry> => {
  const doc = new DecisionHistoryModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as HistoryEntry & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
