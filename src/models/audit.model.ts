/**
 * Mongoose model for the `audit` collection (RBAC-REGISTRO).
 *
 * Migrated from the plain TS `AuditEvent` interface in `auth/audit.ts`. Every privileged
 * decision (RBAC allow/deny on a mutation, login, user mgmt) appends one immutable
 * document here. Mongoose is now the single source of shape + types.
 *
 * `BASE_SCHEMA_OPTS` keeps documents byte-compatible with the pre-migration
 * driver-written docs (no `__v`, no auto timestamps, empty `{}` preserved).
 *
 * The `ts` / `actor_id` / `resource` / `ok` indexes already live in `src/db/indexes.ts`
 * (created by `aitl init-db`), so they are not declared here.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const AUDIT_COLLECTION = "audit";

const now = () => new Date();

const auditSchema = new Schema(
  {
    actor_id: { type: String, required: true },
    actor_role: { type: String, required: true },
    source: { type: String, enum: ["web", "server", "mcp", "cli", "host-agent"], required: true },
    action: { type: String, required: true },
    resource: { type: String, required: true },
    resource_owner: { type: String },
    ok: { type: Boolean, required: true },
    reason: { type: String },
    ts: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: AUDIT_COLLECTION },
);

export type AuditEvent = InferSchemaType<typeof auditSchema>;

export const AuditModel = model("Audit", auditSchema);
