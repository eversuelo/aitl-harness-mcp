/**
 * Mongoose connection for the AITL data layer — the SINGLE owner of the MongoDB
 * connection for the whole process.
 *
 * Everything (models, raw-driver reads via `db/client.getDb()`, index bootstrap) rides
 * on this one connection: `getDb()` hands out the `Db` of Mongoose's underlying
 * MongoClient, so there is exactly one pool to open and one to close.
 *
 * Connection is resilient (ADR-0002): `connectMongoose()` tries `MONGODB_URI` first
 * and, if it is unreachable (cluster down, IP not allowlisted, or a local SRV-DNS
 * failure such as `querySrv ECONNREFUSED`), transparently falls back to
 * `MONGODB_URI_FALLBACK`. The URI that actually connected becomes the active one for
 * the whole process. This primary→fallback logic lives ONLY here.
 */

import mongoose from "mongoose";
import { settings } from "../config.js";

/**
 * Shared schema options for every model, chosen so Mongoose writes documents that are
 * byte-compatible with the existing driver-written docs (anti-corruption):
 *   - versionKey:false → never add `__v` to the durable docs
 *   - timestamps:false → created_at/updated_at are managed in-app (not by Mongoose)
 *   - minimize:false   → keep empty `{}` sub-objects (harness_config, frontmatter, metadata, …)
 */
export const BASE_SCHEMA_OPTS = { versionKey: false, timestamps: false, minimize: false } as const;

const CONNECT_OPTS = {
  appName: "aitl-harness",
  serverSelectionTimeoutMS: 8_000,
  dbName: settings.mongodbDb,
};

let _activeUri: string | null = null;

/** One connection attempt (per candidate URI), as reported to `onAttempt`. */
export interface ConnectAttempt {
  label: string;
  uri: string;
  ok: boolean;
  error?: string;
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

export interface MongooseConnectResult {
  uri: string;
  label: string;
  attempts: ConnectAttempt[];
}

/**
 * Connect Mongoose, trying the primary URI then the optional fallback. Idempotent: a
 * no-op once connected (label "active"). Throws only if every candidate fails
 * (credentials redacted in the message).
 */
export async function connectMongoose(
  preferUri?: string,
  opts: { onAttempt?: (a: ConnectAttempt) => void } = {},
): Promise<MongooseConnectResult> {
  // Already connected → reuse without re-dialing.
  if (mongoose.connection.readyState === 1 && _activeUri) {
    const attempt: ConnectAttempt = { label: "active", uri: redactMongoUri(_activeUri), ok: true };
    return { uri: _activeUri, label: "active", attempts: [attempt] };
  }
  const candidates = preferUri ? [{ label: "preferred", uri: preferUri }] : candidateUris();
  const attempts: ConnectAttempt[] = [];
  let lastError: unknown;
  for (const cand of candidates) {
    try {
      await mongoose.connect(cand.uri, CONNECT_OPTS);
      _activeUri = cand.uri;
      const attempt: ConnectAttempt = { label: cand.label, uri: redactMongoUri(cand.uri), ok: true };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      return { uri: cand.uri, label: cand.label, attempts };
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
      await mongoose.disconnect().catch(() => {});
    }
  }
  const summary = attempts.map((a) => `  - ${a.label} ${a.uri}: ${a.error}`).join("\n");
  const error = new Error(`All MongoDB URIs failed:\n${summary}`);
  (error as Error & { cause?: unknown }).cause = lastError;
  throw error;
}

/** Idempotent connect — call before any model operation on an entry path. */
export async function ensureMongoose(): Promise<void> {
  if (mongoose.connection.readyState !== 1) await connectMongoose();
}

/** The URI Mongoose connected with (or the configured primary if not yet connected). */
export function activeMongooseUri(): string {
  return activeUri();
}

/** Disconnect Mongoose — THE process connection (so CLI/test processes exit cleanly). Idempotent. */
export async function disconnectMongoose(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  _activeUri = null;
}

export { mongoose };
