/**
 * Mongoose model(s) for the project-context definitions — the durable `agents` and
 * `skills` collections.
 *
 * These hold reusable, project-scoped definitions (an AGENTS.md-style agent brief or
 * a SKILLS.md-style skill) that the MCP can serve on every repo call so a client can
 * recover project context. Both collections share ONE document shape (`DefinitionRecord`);
 * only the collection differs (picked by `kind` via `collectionFor`). Roles (H11) are
 * also stored in the `agents` collection as DefinitionRecords with `metadata.kind="role"`.
 *
 * Replaces the former Zod `DefinitionRecordSchema` (in projectctx/schemas.ts): Mongoose
 * is now the single source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps
 * documents byte-compatible with the pre-migration driver-written docs (no `__v`, no
 * auto timestamps, empty `{}` preserved).
 *
 * Intentionally kept OUT of the shared `COLLECTIONS` list in db/client.ts (like
 * `prompts`) so the Python↔TS parity contract stays untouched.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const AGENTS_COLLECTION = "agents";
export const SKILLS_COLLECTION = "skills";
export type DefinitionKind = "agent" | "skill";

export const collectionFor = (kind: DefinitionKind): string =>
  kind === "agent" ? AGENTS_COLLECTION : SKILLS_COLLECTION;

const now = () => new Date();

const definitionSchema = new Schema(
  {
    project: { type: String, required: true },
    name: { type: String, required: true }, // unique per (project, kind); e.g. "code-reviewer"
    description: { type: String, default: "" },
    content: { type: String, default: "" }, // the markdown body / instructions
    source: { type: String, default: "mcp" }, // file path or "mcp"
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS }, // no single `collection`: two models bind the same shape to two collections
);

export type DefinitionRecord = InferSchemaType<typeof definitionSchema>;

/**
 * TWO models over the SAME document shape — the 3rd `model()` arg forces the collection
 * name so `agents` and `skills` stay separate. Mongoose disallows binding one Schema
 * instance to two models, so the second model gets a clone of the schema.
 */
export const AgentModel = model("Agent", definitionSchema, AGENTS_COLLECTION);
export const SkillModel = model("Skill", definitionSchema.clone(), SKILLS_COLLECTION);

/** Pick the model backing a kind's collection (used by DefinitionStore/RoleStore). */
export const modelFor = (kind: DefinitionKind) => (kind === "agent" ? AgentModel : SkillModel);

/** Build + validate a definition record (fills schema defaults). Mirrors the former Zod builder. */
export const makeDefinitionRecord = async (
  v: Partial<DefinitionRecord> & { project: string; name: string },
): Promise<DefinitionRecord> => {
  const doc = new AgentModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as DefinitionRecord & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
