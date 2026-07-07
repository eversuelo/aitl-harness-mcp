/**
 * Mongoose model for the `symbols` collection (the repo map).
 *
 * A `symbol` is a repo-map definition (function/class/…) with its PageRank importance,
 * cached per (project, file) so unchanged files are not re-parsed. Written by
 * `RepoMap.build`, read by `RepoMap.render`.
 *
 * Replaces the former Zod `SymbolSchema`: Mongoose is now the single source of shape +
 * validation + types. `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the
 * pre-migration driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const SYMBOLS_COLLECTION = "symbols";

const now = () => new Date();

const symbolSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    repo: { type: String, default: null }, // repo sub-scope within the project (ADR-0028)
    branch: { type: String, default: null }, // git branch the snapshot was built for (mirrors memory/decisions)
    file: { type: String, required: true },
    name: { type: String, required: true },
    kind: { type: String, required: true },
    refs: { type: [String], default: [] },
    pagerank: { type: Number, default: 0 },
    mtime: { type: Number, default: 0 },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: SYMBOLS_COLLECTION },
);

export type Symbol = InferSchemaType<typeof symbolSchema>;

export const SymbolModel = model("Symbol", symbolSchema);

/** Build + validate a symbol (fills schema defaults). Mirrors the former Zod builder. */
export const makeSymbol = async (v: Partial<Symbol> & { project: string; file: string; name: string; kind: string }): Promise<Symbol> => {
  const doc = new SymbolModel(v);
  await doc.validate(); // rejects with ValidationError (sync validation is deprecated, removed in Mongoose 10)
  const obj = doc.toObject() as Symbol & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
