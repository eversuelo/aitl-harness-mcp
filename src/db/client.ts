/**
 * MongoDB client factory.
 *
 * The exact same code works against the local `mongodb-atlas-local` container and a
 * cloud Atlas cluster — only `MONGODB_URI` differs (ADR-0002).
 */

import { MongoClient, type Db } from "mongodb";
import { settings } from "../config.js";

// Collection names (single source of truth, imported by db/indexes.ts and store.ts)
export const COLLECTIONS = [
  "runs",
  "messages",
  "memory",
  "decisions",
  "prompts",
  "symbols",
  "conventions",
  "categories",
  "events",
] as const;

let _client: MongoClient | null = null;

export interface MongoConnectionReport {
  uri: string;
  dbName: string;
  ok: boolean;
  serverVersion?: string;
}

/** Hide credentials before printing a MongoDB URI to logs/CLI output. */
export function redactMongoUri(uri: string = settings.mongodbUri): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/?#]+@)/i, "$1<credentials>@");
}

/**
 * Cached MongoClient. The Node driver pools connections and auto-connects on the
 * first operation, so callers don't need to await `connect()` explicitly.
 */
export function getClient(): MongoClient {
  if (_client === null) {
    _client = new MongoClient(settings.mongodbUri, {
      appName: "aitl-harness",
      serverSelectionTimeoutMS: 10_000,
    });
  }
  return _client;
}

/** Return the AITL database handle. */
export function getDb(name?: string): Db {
  return getClient().db(name ?? settings.mongodbDb);
}

/** Non-destructive connectivity/auth check for local MongoDB or cloud Atlas. */
export async function checkMongoConnection(name?: string): Promise<MongoConnectionReport> {
  const db = getDb(name);
  const ping = await db.admin().command({ ping: 1 });
  let serverVersion: string | undefined;
  try {
    const buildInfo = await db.admin().command({ buildInfo: 1 });
    serverVersion = typeof buildInfo.version === "string" ? buildInfo.version : undefined;
  } catch {
    serverVersion = undefined;
  }

  return {
    uri: redactMongoUri(),
    dbName: db.databaseName,
    ok: ping.ok === 1,
    serverVersion,
  };
}

/** Close the shared client (used by CLI/tests to exit cleanly). */
export async function closeClient(): Promise<void> {
  if (_client !== null) {
    await _client.close();
    _client = null;
  }
}
