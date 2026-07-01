import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { settings } from "../config.js";
import { ensureMongoose } from "../db/mongoose.js";
import { UserModel, type UserDoc } from "../models/user.model.js";
import { ROLES, type Role, isRole } from "./rbac.js";

const HASH_ITERATIONS = 310_000;
const HASH_KEYLEN = 32;
const HASH_DIGEST = "sha256";

/** Fields safe to return to clients (never hashes/salts). */
export const PUBLIC_USER_PROJECTION = {
  password_hash: 0,
  password_salt: 0,
  password_algo: 0,
  _id: 0,
} as const;

export type { UserDoc };

export interface UserSeed {
  username: string;
  email: string;
  password: string;
  role?: string;
}

export interface PublicUser {
  username: string;
  email: string;
  role: Role;
  disabled?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface BootstrapUserResult {
  status: "skipped" | "created" | "exists" | "needs-root";
  reason?: string;
  username?: string;
  email?: string;
  role?: string;
  /** True when the root was auto-generated as a local fallback (no valid seed). */
  generated?: boolean;
  /** Plaintext password — ONLY present for a generated root, returned once so the
   *  caller can surface it. Never persisted (only the hash is stored). */
  password?: string;
}

export interface VerifyUserResult {
  ok: boolean;
  reason?: string;
  username?: string;
  email?: string;
  role?: string;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Validate a role string against the RBAC role set. */
export function validateRole(role: string): Role {
  if (!isRole(role)) {
    throw new Error(`role must be one of: ${ROLES.join(", ")}.`);
  }
  return role;
}

export function validateUserSeed(seed: UserSeed): void {
  const username = normalizeUsername(seed.username);
  const email = normalizeEmail(seed.email);
  const password = seed.password;

  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error("username must be 3-32 chars and use letters, numbers, dot, underscore or dash.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("email must be a valid email address.");
  }
  if (password.length < 12) {
    throw new Error("password must be at least 12 characters.");
  }
  if (seed.role !== undefined && seed.role !== "") validateRole(seed.role);
}

/** Non-throwing variant of {@link validateUserSeed} — for fallback decisions. */
export function seedIsValid(seed: UserSeed): { ok: boolean; reason?: string } {
  try {
    validateUserSeed(seed);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A self-contained local root seed used as the no-user fallback: a generated,
 * RBAC-compliant password (>= 12 chars) so the harness is usable out of the box
 * on a single-user host. The plaintext is returned to the caller exactly once.
 */
export function generateLocalRootSeed(): UserSeed {
  return {
    username: "local-root",
    email: "local-root@aitl.local",
    password: randomBytes(18).toString("base64url"),
    role: "root",
  };
}

function hashPassword(password: string): { password_hash: string; password_salt: string; password_algo: string } {
  const salt = randomBytes(16).toString("base64url");
  const hash = pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString("base64url");
  return {
    password_hash: hash,
    password_salt: salt,
    password_algo: `pbkdf2:${HASH_DIGEST}:${HASH_ITERATIONS}:${HASH_KEYLEN}`,
  };
}

function verifyPassword(password: string, doc: Record<string, unknown>): boolean {
  if (typeof doc.password_hash !== "string" || typeof doc.password_salt !== "string" || typeof doc.password_algo !== "string") {
    return false;
  }
  const [, digest, iterationsRaw, keylenRaw] = doc.password_algo.split(":");
  const iterations = Number(iterationsRaw);
  const keylen = Number(keylenRaw);
  if (!digest || !Number.isInteger(iterations) || !Number.isInteger(keylen)) return false;

  const expected = Buffer.from(doc.password_hash, "base64url");
  const actual = pbkdf2Sync(password, doc.password_salt, iterations, keylen, digest).subarray(0, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bootstrapSeedFromSettings(): UserSeed | null {
  const username = settings.bootstrapUsername.trim();
  const email = settings.bootstrapEmail.trim();
  const password = settings.bootstrapPassword;
  if (!username && !email && !password) return null;
  if (!username || !email || !password) return null;
  return { username, email, password, role: settings.bootstrapRole.trim() || "root" };
}

export async function countUsers(): Promise<number> {
  await ensureMongoose();
  return UserModel.countDocuments();
}

export async function rootExists(): Promise<boolean> {
  await ensureMongoose();
  return (await UserModel.countDocuments({ role: "root" })) > 0;
}

export async function getUser(username: string): Promise<PublicUser | null> {
  await ensureMongoose();
  const doc = await UserModel.findOne({ username: normalizeUsername(username) }, PUBLIC_USER_PROJECTION).lean();
  return (doc as PublicUser | null) ?? null;
}

export async function listUsers(): Promise<PublicUser[]> {
  await ensureMongoose();
  return (await UserModel.find({}, PUBLIC_USER_PROJECTION)
    .sort({ created_at: 1 })
    .lean()) as unknown as PublicUser[];
}

/**
 * Insert a new user. Validation + uniqueness only — RBAC (only `root` may create
 * users) is enforced at the call site, which also writes the audit event.
 */
export async function createUser(seed: UserSeed): Promise<PublicUser> {
  validateUserSeed(seed);
  const username = normalizeUsername(seed.username);
  const email = normalizeEmail(seed.email);
  const role = validateRole((seed.role ?? "user").trim() || "user");

  await ensureMongoose();
  const existing = await UserModel.findOne({ $or: [{ username }, { email }] }).lean();
  if (existing) throw new Error(`a user with that username or email already exists.`);

  const now = new Date();
  await UserModel.create({
    username,
    email,
    role,
    ...hashPassword(seed.password),
    disabled: false,
    created_at: now,
    updated_at: now,
  });
  return { username, email, role, disabled: false, created_at: now, updated_at: now };
}

export async function setUserRole(username: string, role: string): Promise<PublicUser> {
  const newRole = validateRole(role);
  const uname = normalizeUsername(username);
  await ensureMongoose();
  const res = await UserModel.findOneAndUpdate(
    { username: uname },
    { $set: { role: newRole, updated_at: new Date() } },
    { returnDocument: "after", projection: PUBLIC_USER_PROJECTION },
  ).lean();
  if (!res) throw new Error(`no user '${uname}'.`);
  return res as unknown as PublicUser;
}

export async function setUserDisabled(username: string, disabled: boolean): Promise<PublicUser> {
  const uname = normalizeUsername(username);
  await ensureMongoose();
  const res = await UserModel.findOneAndUpdate(
    { username: uname },
    { $set: { disabled, updated_at: new Date() } },
    { returnDocument: "after", projection: PUBLIC_USER_PROJECTION },
  ).lean();
  if (!res) throw new Error(`no user '${uname}'.`);
  return res as unknown as PublicUser;
}

/**
 * Idempotent first-user bootstrap. Enforces the RBAC-REGISTRO rules:
 *   1. If any user already exists, do not register more here (use `aitl user create`
 *      as an authenticated root).
 *   2. If `users` is empty, create the first root. The seed comes from settings when
 *      valid; otherwise — as the no-user fallback — a local root is auto-generated
 *      (unless `AITL_BOOTSTRAP_AUTOGEN=false`).
 *
 * Never throws: a misconfigured seed degrades to autogen or to a clear `skipped`
 * status, so a bad password can never break server startup.
 */
export async function bootstrapBaseUser(
  seed: UserSeed | null = bootstrapSeedFromSettings(),
): Promise<BootstrapUserResult> {
  await ensureMongoose();
  const total = await UserModel.countDocuments();

  if (total > 0) {
    if (seed) {
      const existing = await UserModel.findOne({
        $or: [{ username: normalizeUsername(seed.username) }, { email: normalizeEmail(seed.email) }],
      }).lean();
      if (existing) {
        return {
          status: "exists",
          username: String(existing.username ?? ""),
          email: String(existing.email ?? ""),
          role: String(existing.role ?? ""),
        };
      }
    }
    return {
      status: "skipped",
      reason: "users already exist; bootstrap only creates the first user. Use an authenticated root (aitl user create).",
    };
  }

  // No users yet → resolve a usable root seed.
  let generated = false;
  let effective = seed;
  const role = (effective?.role ?? "root").trim() || "root";
  if (!effective || !seedIsValid(effective).ok || role !== "root") {
    if (settings.bootstrapAutogen === false) {
      return {
        status: "skipped",
        reason: !effective
          ? "no bootstrap seed configured and autogen disabled (AITL_BOOTSTRAP_AUTOGEN=false)."
          : `bootstrap seed unusable (${seedIsValid(effective).reason ?? "role must be root"}) and autogen disabled.`,
      };
    }
    effective = generateLocalRootSeed();
    generated = true;
  }

  const username = normalizeUsername(effective.username);
  const email = normalizeEmail(effective.email);
  const now = new Date();
  await UserModel.create({
    username,
    email,
    role: "root",
    ...hashPassword(effective.password),
    disabled: false,
    created_at: now,
    updated_at: now,
  });
  return generated
    ? { status: "created", username, email, role: "root", generated: true, password: effective.password }
    : { status: "created", username, email, role: "root" };
}

export async function verifyUserCredentials(opts: UserSeed): Promise<VerifyUserResult> {
  validateUserSeed(opts);
  const username = normalizeUsername(opts.username);
  const email = normalizeEmail(opts.email);
  await ensureMongoose();
  // FULL doc (no public projection) so the stored hash/salt/algo can be verified.
  const user = await UserModel.findOne({ username, email }).lean();
  if (!user) return { ok: false, reason: "user not found for username/email" };
  if (user.disabled === true) return { ok: false, reason: "user is disabled", username, email };
  if (!verifyPassword(opts.password, user as Record<string, unknown>)) return { ok: false, reason: "invalid password", username, email };
  return { ok: true, username, email, role: String(user.role ?? "") };
}
