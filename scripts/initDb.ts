/**
 * Bootstrap the AITL database: collections + scalar/text/vector indexes.
 *
 * Usage: npm run init-db   (or: tsx scripts/initDb.ts)
 *
 * Idempotent. Requires a running MongoDB with Vector Search (the
 * `mongodb/mongodb-atlas-local` container, or cloud Atlas). See README.md.
 */

import { settings } from "../src/config.js";
import { closeClient } from "../src/db/client.js";
import { initIndexes } from "../src/db/indexes.js";

async function main(): Promise<void> {
  console.log(`Connecting to ${settings.mongodbUri} (db=${settings.mongodbDb}) ...`);
  const db = await initIndexes();
  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  console.log(`OK. Collections: ${names.join(", ")}`);
  console.log(
    `Vector index dims = ${settings.embeddingDims} ` +
      `(embedder=${settings.embeddingProvider}:${settings.embeddingModel})`,
  );
  await closeClient();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
