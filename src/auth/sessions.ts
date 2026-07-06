/**
 * Web login sessions (P1 auth) — issue, resolve and revoke bearer tokens.
 *
 * A session is an opaque random token handed to the web client after a successful
 * `POST /api/auth/login`. Only its sha256 hex lands in Mongo (`sessions` collection,
 * TTL-reaped on `expires_at`), so the durable store never holds a usable credential.
 *
 * Every function takes an injectable {@link SessionStore} (defaulting to the real
 * `SessionModel`) so tests run without Mongo — same style as `hooks/approval.ts`.
 */

import { createHash, randomBytes } from "node:crypto";
import { ensureMongoose } from "../db/mongoose.js";
import { SessionModel, makeSessionDoc, type SessionDoc } from "../models/session.model.js";
import { type Role, isRole } from "./rbac.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimal persistence surface the session functions need — injectable for tests. */
export interface SessionStore {
  insert(doc: SessionDoc): Promise<void>;
  findByHash(tokenHash: string): Promise<SessionDoc | null>;
  touch(tokenHash: string, lastSeenAt: Date): Promise<void>;
  deleteByHash(tokenHash: string): Promise<boolean>;
}

const mongoSessionStore: SessionStore = {
  async insert(doc) {
    await ensureMongoose();
    await SessionModel.create(doc);
  },
  async findByHash(tokenHash) {
    await ensureMongoose();
    return (await SessionModel.findOne({ token_hash: tokenHash }).lean()) as SessionDoc | null;
  },
  async touch(tokenHash, lastSeenAt) {
    await ensureMongoose();
    await SessionModel.updateOne({ token_hash: tokenHash }, { $set: { last_seen_at: lastSeenAt } });
  },
  async deleteByHash(tokenHash) {
    await ensureMongoose();
    return (await SessionModel.deleteOne({ token_hash: tokenHash })).deletedCount > 0;
  },
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Session lifetime: `AITL_WEB_SESSION_TTL_MS` override, else 7 days. */
export function sessionTtlMs(): number {
  const n = Number(process.env.AITL_WEB_SESSION_TTL_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  role: string,
  ttlMs: number = sessionTtlMs(),
  store: SessionStore = mongoSessionStore,
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await store.insert(
    makeSessionDoc({
      token_hash: hashToken(token),
      user_id: userId,
      role,
      created_at: now,
      expires_at: expiresAt,
      last_seen_at: now,
      source: "web",
    }),
  );
  return { token, expiresAt };
}

export interface ResolvedSession {
  id: string;
  role: Role;
  source: "web";
}

/**
 * Resolve a bearer token to its actor identity. Returns null for an unknown token,
 * an expired session (the TTL monitor only sweeps periodically, so expiry is checked
 * here too) or a stored role that is no longer a valid RBAC role (fail closed).
 */
export async function resolveSession(
  token: string,
  store: SessionStore = mongoSessionStore,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const doc = await store.findByHash(hashToken(token));
  if (!doc) return null;
  if (new Date(doc.expires_at).getTime() <= Date.now()) return null;
  if (!isRole(doc.role)) return null;
  await store.touch(doc.token_hash, new Date());
  return { id: doc.user_id, role: doc.role, source: "web" };
}

export async function revokeSession(
  token: string,
  store: SessionStore = mongoSessionStore,
): Promise<boolean> {
  if (!token) return false;
  return store.deleteByHash(hashToken(token));
}
