import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionDoc } from "../models/session.model.js";
import {
  type SessionStore,
  createSession,
  hashToken,
  resolveSession,
  revokeSession,
} from "./sessions.js";

/** In-memory SessionStore so the tests run without Mongo. */
function memoryStore(initial: SessionDoc[] = []): SessionStore & { docs: SessionDoc[] } {
  const docs = [...initial];
  return {
    docs,
    async insert(doc) {
      docs.push(doc);
    },
    async findByHash(tokenHash) {
      return docs.find((d) => d.token_hash === tokenHash) ?? null;
    },
    async touch(tokenHash, lastSeenAt) {
      const doc = docs.find((d) => d.token_hash === tokenHash);
      if (doc) doc.last_seen_at = lastSeenAt;
    },
    async deleteByHash(tokenHash) {
      const i = docs.findIndex((d) => d.token_hash === tokenHash);
      if (i < 0) return false;
      docs.splice(i, 1);
      return true;
    },
  };
}

test("createSession issues a base64url token and stores only its sha256 hash", async () => {
  const store = memoryStore();
  const before = Date.now();
  const { token, expiresAt } = await createSession("user:alice", "root", undefined, store);

  assert.match(token, /^[A-Za-z0-9_-]{40,}$/); // 32 random bytes → 43 base64url chars
  assert.equal(store.docs.length, 1);
  const doc = store.docs[0];
  assert.notEqual(doc.token_hash, token);
  assert.equal(doc.token_hash, hashToken(token));
  assert.match(doc.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(doc.user_id, "user:alice");
  assert.equal(doc.role, "root");
  assert.equal(doc.source, "web");
  // Default TTL is 7 days.
  const ttl = expiresAt.getTime() - before;
  assert.ok(ttl > 6.9 * 24 * 60 * 60 * 1000 && ttl < 7.1 * 24 * 60 * 60 * 1000);
});

test("createSession honours an explicit ttlMs", async () => {
  const store = memoryStore();
  const before = Date.now();
  const { expiresAt } = await createSession("user:alice", "admin", 60_000, store);
  const ttl = expiresAt.getTime() - before;
  assert.ok(ttl >= 59_000 && ttl <= 61_000);
});

test("resolveSession returns the identity for a live token and bumps last_seen_at", async () => {
  const store = memoryStore();
  const { token } = await createSession("user:alice", "root", 60_000, store);
  const seenBefore = store.docs[0].last_seen_at;

  await new Promise((r) => setTimeout(r, 5));
  const actor = await resolveSession(token, store);
  assert.deepEqual(actor, { id: "user:alice", role: "root", source: "web" });
  assert.ok(store.docs[0].last_seen_at.getTime() >= seenBefore.getTime());
});

test("resolveSession returns null for an unknown token", async () => {
  const store = memoryStore();
  assert.equal(await resolveSession("no-such-token", store), null);
  assert.equal(await resolveSession("", store), null);
});

test("resolveSession returns null for an expired session", async () => {
  const store = memoryStore();
  const { token } = await createSession("user:alice", "root", 1, store);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await resolveSession(token, store), null);
});

test("resolveSession fails closed on a stored role that is not an RBAC role", async () => {
  const store = memoryStore();
  const { token } = await createSession("user:alice", "root", 60_000, store);
  store.docs[0].role = "superuser";
  assert.equal(await resolveSession(token, store), null);
});

test("revokeSession deletes the session and returns whether it existed", async () => {
  const store = memoryStore();
  const { token } = await createSession("user:alice", "root", 60_000, store);
  assert.equal(await revokeSession(token, store), true);
  assert.equal(store.docs.length, 0);
  assert.equal(await resolveSession(token, store), null);
  assert.equal(await revokeSession(token, store), false);
  assert.equal(await revokeSession("", store), false);
});
