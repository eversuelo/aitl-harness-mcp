import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mongoose } from "../db/mongoose.js";
import { UserModel } from "../models/user.model.js";
import { ROLES } from "./rbac.js";
import {
  RegistrationConflictError,
  bootstrapBaseUser,
  generateLocalRootSeed,
  registerUser,
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

  mock.method(UserModel, "countDocuments", ((query?: { role?: string; username?: { $ne?: string } }) => {
    if (query?.role) return Promise.resolve(docs.filter((d) => d.role === query.role).length);
    // `registerUser` counts real users excluding the local-root bootstrap.
    if (query?.username && typeof query.username === "object" && "$ne" in query.username) {
      return Promise.resolve(docs.filter((d) => d.username !== query.username?.$ne).length);
    }
    return Promise.resolve(docs.length);
  }) as never);

  mock.method(UserModel, "findOne", ((query: {
    $or?: { username?: string; email?: string }[];
    username?: unknown;
    email?: unknown;
  }) => ({
    lean() {
      if (query?.$or) {
        return Promise.resolve(
          docs.find((d) =>
            query.$or!.some((c) => (c.username && d.username === c.username) || (c.email && d.email === c.email)),
          ) ?? null,
        );
      }
      // Direct lookups used by `registerUser`'s per-field uniqueness checks.
      if (typeof query?.username === "string") {
        return Promise.resolve(docs.find((d) => d.username === query.username) ?? null);
      }
      if (typeof query?.email === "string") {
        return Promise.resolve(docs.find((d) => d.email === query.email) ?? null);
      }
      return Promise.resolve(docs[0] ?? null);
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

/* ── registerUser (P3.5 self-service signup) ─────────────────────────────── */

type AuditEv = { action?: string; ok?: boolean; reason?: string | null };

/** Collecting fake for the injectable audit (the real one needs Mongo). */
function fakeAudit(): { events: AuditEv[]; audit: (ev: AuditEv) => Promise<void> } {
  const events: AuditEv[] = [];
  return { events, audit: async (ev) => void events.push(ev) };
}

test("registerUser: the first real user becomes admin (local-root excluded), later ones user", async () => {
  const { docs, restore } = stubUserModel([
    { username: "local-root", email: "local-root@aitl.local", role: "root" },
  ]);
  const { events, audit } = fakeAudit();
  try {
    const first = await registerUser(
      { username: "Alice", email: "Alice@Example.com", password: "longenoughpw12" },
      { audit: audit as never },
    );
    assert.equal(first.role, "admin");
    assert.equal(first.username, "alice"); // normalized lowercase
    assert.equal(first.email, "alice@example.com");

    const second = await registerUser(
      { username: "bob", email: "bob@example.com", password: "longenoughpw12" },
      { audit: audit as never },
    );
    assert.equal(second.role, "user");

    assert.equal(docs.length, 3);
    // Only hashes are persisted, never the plaintext.
    const alice = docs.find((d) => d.username === "alice");
    assert.equal(alice?.password, undefined);
    assert.equal(typeof alice?.password_hash, "string");

    const registers = events.filter((e) => e.action === "register");
    assert.equal(registers.length, 2);
    assert.ok(registers.every((e) => e.ok === true));
    assert.match(registers[0].reason ?? "", /role=admin/);
    assert.match(registers[1].reason ?? "", /role=user/);
  } finally {
    restore();
  }
});

test("registerUser rejects a duplicate username with a distinguishable error", async () => {
  const { restore } = stubUserModel([{ username: "alice", email: "alice@example.com", role: "user" }]);
  const { events, audit } = fakeAudit();
  try {
    await assert.rejects(
      registerUser({ username: "alice", email: "new@example.com", password: "longenoughpw12" }, { audit: audit as never }),
      (err: unknown) => err instanceof RegistrationConflictError && err.conflict === "username" && /username taken/.test(String((err as Error).message)),
    );
    const failed = events.find((e) => e.action === "register" && e.ok === false);
    assert.match(failed?.reason ?? "", /username taken/);
  } finally {
    restore();
  }
});

test("registerUser rejects a duplicate email with a distinguishable error", async () => {
  const { restore } = stubUserModel([{ username: "alice", email: "alice@example.com", role: "user" }]);
  const { audit } = fakeAudit();
  try {
    await assert.rejects(
      registerUser({ username: "brand-new", email: "ALICE@example.com", password: "longenoughpw12" }, { audit: audit as never }),
      (err: unknown) => err instanceof RegistrationConflictError && err.conflict === "email",
    );
  } finally {
    restore();
  }
});

test("registerUser validates the seed like `user create` (password >= 12)", async () => {
  const { docs, restore } = stubUserModel();
  const { audit } = fakeAudit();
  try {
    await assert.rejects(
      registerUser({ username: "alice", email: "alice@example.com", password: "short" }, { audit: audit as never }),
      /at least 12 characters/,
    );
    assert.equal(docs.length, 0);
  } finally {
    restore();
  }
});
