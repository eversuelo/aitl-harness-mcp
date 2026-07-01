import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mongoose } from "../db/mongoose.js";
import { UserModel } from "../models/user.model.js";
import { ROLES } from "./rbac.js";
import {
  bootstrapBaseUser,
  generateLocalRootSeed,
  seedIsValid,
  validateRole,
  validateUserSeed,
} from "./users.js";

/**
 * In-memory stand-in for the `UserModel` statics that `bootstrapBaseUser` touches.
 * Post-Mongoose migration the functions no longer accept an injected `Db`; they call
 * `UserModel.*` directly, so tests stub those statics (and `ensureMongoose`, so no real
 * connection is attempted) and back them with a local `docs` array.
 */
function stubUserModel(initial: Record<string, unknown>[] = []): { docs: Record<string, unknown>[]; restore: () => void } {
  const docs = [...initial];

  // Stub the underlying driver connect so `ensureMongoose()` resolves without a real
  // Atlas connection (the ESM named export cannot be redefined directly).
  mock.method(mongoose, "connect", (async () => mongoose) as never);

  mock.method(UserModel, "countDocuments", ((query?: { role?: string }) => {
    const n = query?.role ? docs.filter((d) => d.role === query.role).length : docs.length;
    return Promise.resolve(n);
  }) as never);

  mock.method(UserModel, "findOne", ((query: { $or?: { username?: string; email?: string }[] }) => ({
    lean() {
      if (!query?.$or) return Promise.resolve(docs[0] ?? null);
      return Promise.resolve(
        docs.find((d) =>
          query.$or!.some((c) => (c.username && d.username === c.username) || (c.email && d.email === c.email)),
        ) ?? null,
      );
    },
  })) as never);

  mock.method(UserModel, "create", ((doc: Record<string, unknown>) => {
    docs.push(doc);
    return Promise.resolve(doc);
  }) as never);

  return { docs, restore: () => mock.restoreAll() };
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
  const { docs, restore } = stubUserModel();
  try {
    const res = await bootstrapBaseUser(null); // no seed at all
    assert.equal(res.status, "created");
    assert.equal(res.generated, true);
    assert.equal(res.role, "root");
    assert.ok((res.password ?? "").length >= 12);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].role, "root");
    // The plaintext password is never persisted — only the hash.
    assert.equal(docs[0].password, undefined);
    assert.equal(typeof docs[0].password_hash, "string");
  } finally {
    restore();
  }
});

test("bootstrapBaseUser never throws on an invalid seed (falls back to autogen)", async () => {
  const { restore } = stubUserModel();
  try {
    const res = await bootstrapBaseUser({ username: "x", email: "x@y.co", password: "short" });
    assert.equal(res.status, "created");
    assert.equal(res.generated, true);
  } finally {
    restore();
  }
});

test("bootstrapBaseUser is a no-op when users already exist", async () => {
  const { docs, restore } = stubUserModel([{ username: "someone", email: "s@e.co", role: "root" }]);
  try {
    const res = await bootstrapBaseUser(null);
    assert.equal(res.status, "skipped");
    assert.equal(docs.length, 1);
  } finally {
    restore();
  }
});
