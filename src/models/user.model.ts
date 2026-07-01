/**
 * Mongoose model for the `users` collection (RBAC-REGISTRO).
 *
 * Migrated from the plain TS interface in `auth/users.ts` to a Mongoose Schema: Mongoose
 * is now the single source of shape + types for user documents. This collection is
 * SENSITIVE (password hashes + RBAC roles), so the schema mirrors the pre-migration
 * driver-written docs field-for-field.
 *
 * `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the pre-migration docs
 * (no `__v`, no auto timestamps — created_at/updated_at stay app-managed, empty `{}`
 * preserved).
 *
 * The unique indexes on `username`/`email` (and the `created_at`/`role` indexes) are
 * NOT declared here on purpose: they already live in `src/db/indexes.ts` and are created
 * by `aitl init-db`. Declaring them here too would duplicate index management.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const USERS_COLLECTION = "users";

const now = () => new Date();

const userSchema = new Schema(
  {
    username: { type: String, required: true },
    email: { type: String, required: true },
    role: { type: String, required: true },
    password_hash: { type: String, required: true },
    password_salt: { type: String },
    password_algo: { type: String },
    disabled: { type: Boolean, default: false },
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: USERS_COLLECTION },
);

export type UserDoc = InferSchemaType<typeof userSchema>;

export const UserModel = model("User", userSchema);
