/**
 * Mongoose model for the `decisions` collection — an Architecture Decision Record (Nygard).
 *
 * ADRs are the durable answer to decision amnesia (Pain point #1): they live as markdown in
 * git AND here, machine-retrievable via Atlas `$vectorSearch` alongside memory and chats.
 * Keyed by (project, id). `version` is bumped on each content change (prior versions archived
 * append-only in `decisions_history`, ADR-0027). `embedding` is set by the embedder on write
 * and stripped only on the documented read projections.
 *
 * Extracted from the shared Zod `ADRSchema` (memory/schemas.ts): Mongoose is now the single
 * source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible
 * with the pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}`
 * preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const DECISIONS_COLLECTION = "decisions";

/** ADR lifecycle states (F4): `deprecated` keeps the doc (append-only trazability) but hides it from hydrate. */
export const ADR_STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

const now = () => new Date();

const adrSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
    id: { type: String, required: true }, // e.g. "0001"
    title: { type: String, required: true },
    context: { type: String, required: true },
    decision: { type: String, required: true },
    // Not `required`: Mongoose required-on-String rejects "" (the MCP tool's default),
    // and legacy docs may lack the field — deprecation must still work on them.
    consequences: { type: String, default: "" },
    status: { type: String, enum: ADR_STATUSES, default: "accepted" },
    /** Why this ADR was deprecated (lifecycle F4; null while active). */
    deprecation_reason: { type: String, default: null },
    /** Id of the ADR that replaces this one (e.g. "0031"). */
    superseded_by: { type: String, default: null },
    /** Soft TTL: past this date the ADR is flagged "needs review" and excluded from hydrate. NEVER deleted. */
    review_after: { type: Date, default: null },
    /** Dirs/modules this ADR constrains (consumed by module-brief, P6). */
    components: { type: [String], default: [] },
    model: { type: String, default: null },
    trigger: { type: String, default: null },
    git_ref: { type: String, default: null },
    version: { type: Number, default: 1 }, // bumped on each content change; history in decisions_history
    actor_id: { type: String, default: null }, // who authored the current version (provenance)
    actor_role: { type: String, default: null },
    branch: { type: String, default: null }, // git branch this version was authored on (ADR-0028)
    commit_sha: { type: String, default: null }, // git commit this version was authored at (F2)
    embedding: { type: [Number], default: null },
  },
  { ...BASE_SCHEMA_OPTS, collection: DECISIONS_COLLECTION },
);

export type ADR = InferSchemaType<typeof adrSchema>;

export const DecisionModel = model("Decision", adrSchema);

/** Build + validate an ADR (fills schema defaults). Mirrors the former Zod builder. */
export const makeADR = async (
  v: Partial<ADR> & { project: string; id: string; title: string; context: string; decision: string; consequences: string },
): Promise<ADR> => {
  const doc = new DecisionModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as ADR & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
