/**
 * Database bootstrap as an importable function (P5). Extracted from `scripts/initDb.ts`
 * (now a thin wrapper) so `aitl init` and `aitl init-db` share ONE implementation:
 * collections + scalar/text indexes, best-effort Atlas vector indexes, and the
 * first-root bootstrap (`bootstrapBaseUser`, ADR-0026 — no-op once any user exists).
 *
 * Vector-index failure is REPORTED, not thrown: a plain mongod (no Search) can still
 * run the whole memory pipeline through the text/recency fallbacks, so `aitl init`
 * must not abort on it. Callers that want the old hard failure (the script) check
 * `report.vector.ok` themselves.
 */

import { bootstrapBaseUser, type BootstrapUserResult } from "../auth/users.js";
import { getDb } from "./client.js";
import { ensureCollections, ensureScalarIndexes, ensureTextIndexes, ensureVectorIndexes } from "./indexes.js";
import { ensureMongoose } from "./mongoose.js";

export interface DbInitReport {
  /** Every collection present after the bootstrap (sorted). */
  collections: string[];
  /** Atlas vector-index creation outcome (best-effort; false on plain mongod). */
  vector: { ok: boolean; error?: string };
  /** First-root bootstrap outcome (created | exists | skipped, ADR-0026). */
  bootstrap: BootstrapUserResult;
}

/** Create collections + indexes and bootstrap the first root user. Idempotent. */
export async function initDb(): Promise<DbInitReport> {
  await ensureMongoose(); // opens the shared connection getDb() rides on
  const db = getDb();
  await ensureCollections(db);
  await ensureScalarIndexes(db);
  await ensureTextIndexes(db);
  let vector: DbInitReport["vector"] = { ok: true };
  try {
    await ensureVectorIndexes(db);
  } catch (err) {
    vector = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const bootstrap = await bootstrapBaseUser();
  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();
  return { collections, vector, bootstrap };
}
