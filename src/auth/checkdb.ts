/**
 * RBAC readiness check for `aitl check-db`.
 *
 * Implements the "Flujo de check-db" from docs/RBAC-REGISTRO.md:
 *   1. users collection exists
 *   2. unique indexes on username/email
 *   3. a root user exists
 *   4. if empty + bootstrap env complete + role=root → create the first root
 *   5. otherwise emit an actionable warning
 *
 * Connectivity is checked separately (the caller pings Mongo first). This is
 * read-mostly: it only writes when creating the very first root user.
 */

import type { Db } from "mongodb";
import { getDb } from "../db/client.js";
import { bootstrapBaseUser, countUsers, rootExists } from "./users.js";

const MISSING_ROOT_HINT =
  "Set AITL_BOOTSTRAP_USERNAME, AITL_BOOTSTRAP_EMAIL, AITL_BOOTSTRAP_PASSWORD,\n" +
  "AITL_BOOTSTRAP_ROLE=root and run aitl check-db again.";

export interface RbacCheckResult {
  ready: boolean;
  lines: string[];
}

async function hasUniqueIndex(db: Db, field: string): Promise<boolean> {
  try {
    const indexes = await db.collection("users").indexes();
    return indexes.some(
      (ix) => ix.unique === true && ix.key && Object.keys(ix.key).length === 1 && ix.key[field] !== undefined,
    );
  } catch {
    return false;
  }
}

export async function checkRbac(db: Db = getDb()): Promise<RbacCheckResult> {
  const lines: string[] = [];

  const collections = new Set((await db.listCollections().toArray()).map((c) => c.name));
  if (!collections.has("users")) {
    lines.push("Users collection: missing (run aitl init-db)");
    lines.push("RBAC status: not-initialized");
    return { ready: false, lines };
  }
  lines.push("Users collection OK");

  const uniqueUsername = await hasUniqueIndex(db, "username");
  const uniqueEmail = await hasUniqueIndex(db, "email");
  if (!uniqueUsername || !uniqueEmail) {
    const missing = [!uniqueUsername && "username", !uniqueEmail && "email"].filter(Boolean).join(", ");
    lines.push(`Unique indexes: missing on ${missing} (run aitl init-db)`);
  } else {
    lines.push("Unique indexes OK (username, email)");
  }

  // Auto-bootstrap the first root when the collection is empty. With a valid seed it
  // uses it; otherwise it falls back to a generated local root (unless autogen is off).
  if ((await countUsers(db)) === 0) {
    const result = await bootstrapBaseUser(db);
    if (result.status === "created") {
      lines.push(`Root user: created (${result.username})`);
      if (result.generated && result.password) {
        lines.push(`  ⚠ generated password: ${result.password}`);
        lines.push("  (save this now — it is shown only once and is not recoverable)");
      }
    } else if (result.reason) {
      lines.push(`Bootstrap: ${result.reason}`);
    }
  }

  if (await rootExists(db)) {
    lines.push("Root user: exists");
    lines.push("RBAC status: ready");
    return { ready: true, lines };
  }

  lines.push("Root user: missing");
  lines.push("RBAC status: missing-root");
  lines.push(MISSING_ROOT_HINT);
  return { ready: false, lines };
}
