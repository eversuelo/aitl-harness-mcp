/**
 * Lazy storage bootstrap for the coordination collections (ADR-0002 v1).
 *
 * `aitl init-db` creates these indexes too (src/db/indexes.ts is the single source of
 * truth), but claim atomicity DEPENDS on the partial unique index existing — a racing
 * insert must fail with E11000, not silently create a second active claim. So, like
 * `ensureMcpStorage` in the MCP server, the coord stores self-ensure their indexes
 * once per process before the first write (idempotent `createIndex`).
 */

import { getDb } from "../db/client.js";
import { ensureMongoose } from "../db/mongoose.js";
import { COORD_EVENTS_COLLECTION } from "../models/coordEvent.model.js";
import { TASK_CLAIMS_COLLECTION } from "../models/taskClaim.model.js";

let coordStorageReady: Promise<void> | null = null;

export async function ensureCoordStorage(): Promise<void> {
  if (coordStorageReady === null) {
    coordStorageReady = (async () => {
      await ensureMongoose(); // opens the shared connection getDb() rides on
      const db = getDb();
      for (const name of [TASK_CLAIMS_COLLECTION, COORD_EVENTS_COLLECTION]) {
        const exists = await db.listCollections({ name }).hasNext();
        if (!exists) {
          try {
            await db.createCollection(name);
          } catch (err) {
            if (!String(err).includes("already exists")) throw err;
          }
        }
      }
      // MUST mirror src/db/indexes.ts (the partial unique index IS the claim lock).
      await db.collection(TASK_CLAIMS_COLLECTION).createIndex(
        { project: 1, task_key: 1 },
        { unique: true, partialFilterExpression: { released: false } },
      );
      await db.collection(TASK_CLAIMS_COLLECTION).createIndex({ project: 1, claimed_at: -1 });
      await db.collection(COORD_EVENTS_COLLECTION).createIndex({ project: 1, created_at: 1 });
    })().catch((err) => {
      coordStorageReady = null;
      throw err;
    });
  }
  await coordStorageReady;
}
