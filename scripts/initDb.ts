/**
 * Bootstrap the AITL database: collections + scalar/text/vector indexes.
 *
 * Usage: npm run init-db   (or: tsx scripts/initDb.ts)
 *
 * Thin wrapper over `src/db/init.ts` (P5) so `aitl init` shares the same logic.
 * Idempotent. Requires a running MongoDB; vector indexes need Vector Search (the
 * `mongodb/mongodb-atlas-local` container, or cloud Atlas). See README.md.
 */

import { settings } from "../src/config.js";
import { closeClient } from "../src/db/client.js";
import { initDb } from "../src/db/init.js";

async function main(): Promise<void> {
  console.log(`Connecting to ${settings.mongodbUri} (db=${settings.mongodbDb}) ...`);
  const report = await initDb();
  console.log(`OK. Collections: ${report.collections.join(", ")}`);
  console.log(
    `Bootstrap user: ${report.bootstrap.status}` +
      (report.bootstrap.username ? ` (${report.bootstrap.username}, ${report.bootstrap.email})` : ""),
  );
  console.log(
    `Vector index dims = ${settings.embeddingDims} ` +
      `(embedder=${settings.embeddingProvider}:${settings.embeddingModel})`,
  );
  if (!report.vector.ok) {
    // Preserve the script's historical hard failure on missing Vector Search.
    console.error(report.vector.error);
    process.exitCode = 1;
  }
  await closeClient();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
