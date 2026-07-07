/**
 * MongoDB client access — a thin compatibility layer over the ONE Mongoose-owned
 * connection (`db/mongoose.ts`).
 *
 * The exact same code works against the local `mongodb-atlas-local` container and a
 * cloud Atlas cluster — only `MONGODB_URI` differs (ADR-0002). Primary→fallback
 * resolution lives in `connectMongoose()`; `connectWithFallback()` just delegates and
 * keeps the historical report shape for the CLI/MCP callers.
 *
 * `getClient()`/`getDb()` hand out the MongoClient/Db of Mongoose's underlying driver
 * connection, so raw-driver reads (sibling collections, aggregations) share the same
 * pool as the models. They are synchronous and require the connection to be open:
 * every entry path (`connectWithFallback`, `ensureMongoose`, any model call) opens it.
 */

import type { Db, MongoClient } from "mongodb";
import { settings } from "../config.js";
import {
  type ConnectAttempt,
  activeUri,
  candidateUris,
  connectMongoose,
  disconnectMongoose,
  mongoose,
  redactMongoUri,
} from "./mongoose.js";

// Collection names (single source of truth, imported by db/indexes.ts and store.ts)
export const COLLECTIONS = [
  "runs",
  "messages",
  "memory",
  "decisions",
  "decisions_history",
  "memory_history",
  "prompts",
  "mcp_context",
  "mcp_tool_calls",
  "users",
  "sessions",
  "audit",
  "symbols",
  "conventions",
  "categories",
  "events",
  "softwares",
  "repos",
  "branches",
  "task_claims",
  "coord_events",
] as const;

export { activeUri, candidateUris, redactMongoUri };
export type { ConnectAttempt };

export interface MongoConnectionReport {
  uri: string;
  dbName: string;
  ok: boolean;
  serverVersion?: string;
}

export interface ConnectResult extends MongoConnectionReport {
  label: string;
  attempts: ConnectAttempt[];
}

/**
 * The MongoClient underlying the Mongoose connection (single shared pool). Requires
 * an open connection — await `connectWithFallback()`/`ensureMongoose()` on the entry
 * path first (every CLI/server entry path already does).
 */
export function getClient(): MongoClient {
  if (mongoose.connection.readyState !== 1) {
    throw new Error(
      "MongoDB is not connected — await connectWithFallback() or ensureMongoose() before getClient()/getDb().",
    );
  }
  return mongoose.connection.getClient();
}

/** Return the AITL database handle (from the shared Mongoose connection). */
export function getDb(name?: string): Db {
  return getClient().db(name ?? settings.mongodbDb);
}

/**
 * Establish the shared (Mongoose-owned) connection, trying each candidate URI until
 * one answers. Idempotent: once connected this is a cheap no-op that re-pings. Throws
 * only if every candidate fails (the error lists what was tried, credentials redacted).
 */
export async function connectWithFallback(opts: {
  name?: string;
  onAttempt?: (a: ConnectAttempt) => void;
} = {}): Promise<ConnectResult> {
  const { label, attempts } = await connectMongoose(undefined, { onAttempt: opts.onAttempt });
  const report = await checkMongoConnection(opts.name);
  return { ...report, label, attempts };
}

/** Non-destructive connectivity/auth check for local MongoDB or cloud Atlas. */
export async function checkMongoConnection(name?: string): Promise<MongoConnectionReport> {
  await connectMongoose();
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

/** Close the shared connection (used by CLI/tests to exit cleanly). Idempotent. */
export async function closeClient(): Promise<void> {
  await disconnectMongoose();
}
