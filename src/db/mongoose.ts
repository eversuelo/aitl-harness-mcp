/**
 * Mongoose connection for the AITL data layer.
 *
 * Part of the incremental migration from the raw `mongodb` driver to Mongoose. Uses the
 * SAME connection contract as `db/client.ts`: the configured `mongodb+srv://…` seedlist
 * URI (no explicit shard hosts, no `directConnection`) with the same primary→fallback
 * behaviour. During the migration Mongoose runs alongside the legacy driver client; both
 * point at the same URI and database, so no data moves.
 */

import mongoose from "mongoose";
import { settings } from "../config.js";
import { candidateUris, redactMongoUri } from "./client.js";

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

/**
 * Connect Mongoose, trying the primary URI then the optional fallback (mirrors
 * `connectWithFallback`). Idempotent: a no-op once connected. Throws only if every
 * candidate fails (credentials redacted in the message).
 */
export async function connectMongoose(preferUri?: string): Promise<string> {
  if (mongoose.connection.readyState === 1 && _activeUri) return _activeUri;
  const candidates = preferUri ? [{ label: "preferred", uri: preferUri }] : candidateUris();
  let lastError: unknown;
  for (const cand of candidates) {
    try {
      await mongoose.connect(cand.uri, CONNECT_OPTS);
      _activeUri = cand.uri;
      return cand.uri;
    } catch (err) {
      lastError = err;
      await mongoose.disconnect().catch(() => {});
    }
  }
  const summary = candidates.map((c) => `  - ${c.label} ${redactMongoUri(c.uri)}`).join("\n");
  const error = new Error(`Mongoose failed to connect to any MongoDB URI:\n${summary}`);
  (error as Error & { cause?: unknown }).cause = lastError;
  throw error;
}

/** Idempotent connect — call before any model operation on an entry path. */
export async function ensureMongoose(): Promise<void> {
  if (mongoose.connection.readyState !== 1) await connectMongoose();
}

/** The URI Mongoose connected with (or the configured primary if not yet connected). */
export function activeMongooseUri(): string {
  return _activeUri ?? settings.mongodbUri;
}

/** Disconnect Mongoose (so CLI/test processes can exit cleanly). Idempotent. */
export async function disconnectMongoose(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  _activeUri = null;
}

export { mongoose };
