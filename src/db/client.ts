/**
 * MongoDB client factory.
 *
 * The exact same code works against the local `mongodb-atlas-local` container and a
 * cloud Atlas cluster — only `MONGODB_URI` differs (ADR-0002).
 *
 * To make the harness run **local and/or Atlas** without manual edits, connection is
 * resilient: `connectWithFallback()` tries `MONGODB_URI` first and, if it is
 * unreachable (cluster down, IP not allowlisted, or a local SRV-DNS failure such as
 * `querySrv ECONNREFUSED`), transparently falls back to `MONGODB_URI_FALLBACK`. The
 * URI that actually answered a `ping` becomes the active one for the whole process.
 */

import { MongoClient, type Db } from "mongodb";
import { settings } from "../config.js";

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
  "audit",
  "symbols",
  "conventions",
  "categories",
  "events",
  "softwares",
  "repos",
  "branches",
] as const;

let _client: MongoClient | null = null;
/** The URI that actually answered a ping (set by connectWithFallback). */
let _activeUri: string | null = null;

export interface MongoConnectionReport {
  uri: string;
  dbName: string;
  ok: boolean;
  serverVersion?: string;
}

/** Hide credentials before printing a MongoDB URI to logs/CLI output. */
export function redactMongoUri(uri: string = activeUri()): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/?#]+@)/i, "$1<credentials>@");
}

/** The URI currently in use (the one that connected, or the configured primary). */
export function activeUri(): string {
  return _activeUri ?? settings.mongodbUri;
}

/** Candidate URIs in priority order: primary first, optional fallback second. */
export function candidateUris(): { label: string; uri: string }[] {
  const list = [{ label: "primary", uri: settings.mongodbUri }];
  const fb = settings.mongodbUriFallback.trim();
  if (fb && fb !== settings.mongodbUri) list.push({ label: "fallback", uri: fb });
  return list;
}

/**
 * Cached MongoClient. The Node driver pools connections and auto-connects on the
 * first operation, so callers don't need to await `connect()` explicitly. Uses the
 * active URI (set by connectWithFallback) if one has been chosen.
 */
export function getClient(): MongoClient {
  if (_client === null) {
    _client = new MongoClient(activeUri(), {
      appName: "aitl-harness",
      serverSelectionTimeoutMS: 10_000,
    });
  }
  return _client;
}

export interface ConnectAttempt {
  label: string;
  uri: string;
  ok: boolean;
  error?: string;
}

export interface ConnectResult extends MongoConnectionReport {
  label: string;
  attempts: ConnectAttempt[];
}

/**
 * Establish the shared client, trying each candidate URI until one answers a ping.
 * Idempotent: once a client is connected this is a cheap no-op that re-pings. Throws
 * only if every candidate fails (the error lists what was tried, credentials redacted).
 */
export async function connectWithFallback(opts: {
  name?: string;
  onAttempt?: (a: ConnectAttempt) => void;
} = {}): Promise<ConnectResult> {
  // Already connected → reuse without re-dialing.
  if (_client !== null && _activeUri !== null) {
    const report = await checkMongoConnection(opts.name);
    return { ...report, label: "active", attempts: [{ label: "active", uri: report.uri, ok: report.ok }] };
  }

  const attempts: ConnectAttempt[] = [];
  let lastError: unknown;
  for (const cand of candidateUris()) {
    const client = new MongoClient(cand.uri, {
      appName: "aitl-harness",
      serverSelectionTimeoutMS: 8_000,
    });
    try {
      await client.db(settings.mongodbDb).admin().command({ ping: 1 });
      _client = client;
      _activeUri = cand.uri;
      const attempt: ConnectAttempt = { label: cand.label, uri: redactMongoUri(cand.uri), ok: true };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      const report = await checkMongoConnection(opts.name);
      return { ...report, label: cand.label, attempts };
    } catch (err) {
      lastError = err;
      const attempt: ConnectAttempt = {
        label: cand.label,
        uri: redactMongoUri(cand.uri),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      await client.close().catch(() => {});
    }
  }

  const summary = attempts.map((a) => `  - ${a.label} ${a.uri}: ${a.error}`).join("\n");
  const error = new Error(`All MongoDB URIs failed:\n${summary}`);
  (error as Error & { cause?: unknown }).cause = lastError;
  throw error;
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
    _activeUri = null;
  }
  // Migration: also drop the Mongoose connection so CLI processes exit cleanly. No-op
  // until a model has connected Mongoose; imported lazily to avoid a static import cycle.
  try {
    const { disconnectMongoose } = await import("./mongoose.js");
    await disconnectMongoose();
  } catch {
    /* mongoose not loaded/connected — nothing to close */
  }
}
