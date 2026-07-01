/**
 * Audit log — durable record of sensitive actions (accepted and rejected).
 *
 * Every privileged decision (RBAC allow/deny on a mutation, login, user mgmt)
 * appends one `AuditEvent` to the `audit` collection. Auditors read it; nobody
 * mutates it through normal flows. Mirrors the shape in `docs/RBAC-REGISTRO.md`.
 *
 * Migrated to the Mongoose `AuditModel` (single source of shape + types).
 */

import { ensureMongoose } from "../db/mongoose.js";
import { AUDIT_COLLECTION, AuditModel, type AuditEvent } from "../models/audit.model.js";

export { AUDIT_COLLECTION };
export type { AuditEvent };

/**
 * Append an audit event. Never throws into the caller's path: auditing must not
 * break the operation it records, so failures are logged to stderr and swallowed.
 */
export async function recordAudit(event: Omit<AuditEvent, "ts"> & { ts?: Date }): Promise<void> {
  const doc: AuditEvent = { ...event, ts: event.ts ?? new Date() };
  try {
    await ensureMongoose();
    await AuditModel.create(doc);
  } catch (err) {
    console.error(`[audit] failed to record event: ${err instanceof Error ? err.message : String(err)}`);
  }
}
