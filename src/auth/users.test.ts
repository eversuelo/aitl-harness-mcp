import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "mongodb";
import { ROLES } from "./rbac.js";
import {
  bootstrapBaseUser,
  generateLocalRootSeed,
  seedIsValid,
  validateRole,
  validateUserSeed,
} from "./users.js";

/** Minimal in-memory stand-in for the bits of `Db` that bootstrapBaseUser touches. */
function fakeDb(initial: Record<string, unknown>[] = []): { db: Db; docs: Record<string, unknown>[] } {
  const docs = [...initial];
  const db = {
    collection() {
      return {
        async countDocuments() {
          return docs.length;
        },
        async findOne(query: { $or?: { username?: string; email?: string }[] }) {
          if (!query?.$or) return docs[0] ?? null;
          return (
            docs.find((d) =>
              query.$or!.some(
                (c) => (c.username && d.username === c.username) || (c.email && d.email === c.email),
              ),
            ) ?? null
          );
        },
        async insertOne(doc: Record<string, unknown>) {
          docs.push(doc);
          return { insertedId: docs.length };
        },
      };
    },
  } as unknown as Db;
  return { db, docs };
}

test("validateRole accepts every RBAC role", () => {
  for (const role of ROLES) assert.equal(validateRole(role), role);
});

test("validateRole rejects unknown roles", () => {
  assert.throws(() => validateRole("superuser"), /role must be one of/);
});

test("validateUserSeed rejects an invalid role", () => {
  assert.throws(
    () => validateUserSeed({ username: "alice", email: "a@b.co", password: "longpassword12", role: "ceo" }),
    /role must be one of/,
  );
});

test("validateUserSeed enforces password length", () => {
  assert.throws(
    () => validateUserSeed({ username: "alice", email: "a@b.co", password: "short" }),
    /at least 12 characters/,
  );
});

test("validateUserSeed accepts a well-formed seed", () => {
  assert.doesNotThrow(() =>
    validateUserSeed({ username: "alice", email: "alice@example.com", password: "longenoughpw12", role: "user" }),
  );
});

test("seedIsValid does not throw and reports the reason", () => {
  assert.deepEqual(seedIsValid({ username: "alice", email: "alice@example.com", password: "longenoughpw12" }), {
    ok: true,
  });
  const bad = seedIsValid({ username: "alice", email: "alice@example.com", password: "short" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /at least 12 characters/);
});

test("generateLocalRootSeed produces a valid root seed", () => {
  const seed = generateLocalRootSeed();
  assert.equal(seed.role, "root");
  assert.ok(seed.password.length >= 12);
  assert.equal(seedIsValid(seed).ok, true);
});

test("bootstrapBaseUser auto-generates a local root when no users and no valid seed", async () => {
  const { db, docs } = fakeDb();
  const res = await bootstrapBaseUser(db, null); // no seed at all
  assert.equal(res.status, "created");
  assert.equal(res.generated, true);
  assert.equal(res.role, "root");
  assert.ok((res.password ?? "").length >= 12);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].role, "root");
  // The plaintext password is never persisted — only the hash.
  assert.equal(docs[0].password, undefined);
  assert.equal(typeof docs[0].password_hash, "string");
});

test("bootstrapBaseUser never throws on an invalid seed (falls back to autogen)", async () => {
  const { db } = fakeDb();
  const res = await bootstrapBaseUser(db, { username: "x", email: "x@y.co", password: "short" });
  assert.equal(res.status, "created");
  assert.equal(res.generated, true);
});

test("bootstrapBaseUser is a no-op when users already exist", async () => {
  const { db, docs } = fakeDb([{ username: "someone", email: "s@e.co", role: "root" }]);
  const res = await bootstrapBaseUser(db, null);
  assert.equal(res.status, "skipped");
  assert.equal(docs.length, 1);
});
