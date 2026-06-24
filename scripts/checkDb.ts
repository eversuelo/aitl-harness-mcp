/**
 * Non-destructive MongoDB connectivity check.
 *
 * Usage: npm run check-db   (or: tsx scripts/checkDb.ts)
 */

import { checkMongoConnection, closeClient } from "../src/db/client.js";

async function main(): Promise<void> {
  const report = await checkMongoConnection();
  console.log(`MongoDB ping OK: ${report.uri} (db=${report.dbName})`);
  if (report.serverVersion !== undefined) {
    console.log(`Server version: ${report.serverVersion}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeClient();
  });
