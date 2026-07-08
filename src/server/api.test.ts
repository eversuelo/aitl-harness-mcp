import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Role } from "../auth/rbac.js";
import { RegistrationConflictError } from "../auth/users.js";
import { type ApiDeps, createApiServer } from "./api.js";

type AuditRecord = Parameters<ApiDeps["audit"]>[0];

/** In-memory fakes for every effect-ful dependency, so no Mongo/embedder is touched. */
function makeFakes() {
  const sessions = new Map<string, { id: string; role: Role }>();
  const audits: AuditRecord[] = [];
  const registered: { username: string; email: string }[] = [];
  const configCalls: Record<string, string | null>[] = [];
  const restarts: number[] = [];
  // Default: healthy DB with users → setup closed (individual tests mutate it).
  let setupState: { setup_required: boolean; mongo: { ok: boolean; error?: string; db?: string }; has_real_users: boolean | null } = {
    setup_required: false,
    mongo: { ok: true, db: "fake" },
    has_real_users: true,
  };
  let seq = 0;
  const deps: Partial<ApiDeps> = {
    resolveSession: async (token) => {
      const s = sessions.get(token);
      return s ? { ...s, source: "web" } : null;
    },
    createSession: async (userId, role) => {
      const token = `fake-token-${++seq}`;
      sessions.set(token, { id: userId, role: role as Role });
      return { token, expiresAt: new Date(Date.now() + 60_000) };
    },
    revokeSession: async (token) => sessions.delete(token),
    verifyCredentials: async (username, password) =>
      username === "root" && password === "correct-horse-battery"
        ? { ok: true, username: "root", email: "root@aitl.local", role: "root" }
        : { ok: false, reason: "invalid password" },
    // Mirrors registerUser semantics: per-field conflicts, first user → admin.
    registerUser: async (seed) => {
      if (seed.password.length < 12) throw new Error("password must be at least 12 characters.");
      if (registered.some((r) => r.username === seed.username)) throw new RegistrationConflictError("username");
      if (registered.some((r) => r.email === seed.email)) throw new RegistrationConflictError("email");
      registered.push({ username: seed.username, email: seed.email });
      return { username: seed.username, role: registered.length === 1 ? "admin" : "user" };
    },
    applyConfigUpdates: async (updates) => {
      configCalls.push(updates);
      return { profilePath: "/fake/config.json", envPath: "/fake/.env", keys: Object.keys(updates) };
    },
    audit: async (ev) => {
      audits.push(ev);
    },
    upsertMemory: async (body) => ({ slug: String(body.slug ?? ""), project: String(body.project ?? "") }),
    // ── setup + admin fakes (ADR-0061) ────────────────────────────────────
    setupStatus: async () => setupState,
    createSetupRoot: async (seed) => {
      if (setupState.has_real_users) {
        const err = new Error("setup closed");
        err.name = "SetupClosedError";
        throw err;
      }
      if (seed.password.length < 12) throw new Error("password must be at least 12 characters.");
      registered.push({ username: seed.username, email: seed.email });
      setupState = { setup_required: false, mongo: setupState.mongo, has_real_users: true };
      return { username: seed.username, role: "root" };
    },
    probeMongo: async (uri, db) =>
      uri.startsWith("mongodb://ok") ? { ok: true, db } : { ok: false, error: "unreachable", db },
    requestRestart: () => {
      restarts.push(1);
    },
    runInitDb: async () => ({ db: "fake", collections: ["users"], vector: { ok: true } }),
  };
  const setSetupState = (next: { setup_required: boolean; mongo: { ok: boolean; error?: string; db?: string }; has_real_users: boolean | null }) => {
    setupState = next;
  };
  return { deps, sessions, audits, registered, configCalls, restarts, setSetupState };
}

async function startServer(deps: Partial<ApiDeps>): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const MEMORY_BODY = JSON.stringify({ project: "p", slug: "s", body: "hello", description: "d" });

test("POST /api/memory without auth → 401 login_required", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: MEMORY_BODY,
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string; hint?: string };
    assert.equal(body.error, "login_required");
    assert.equal(body.hint, "POST /api/auth/login");
  } finally {
    await close();
  }
});

test("login → bearer token → authenticated write succeeds", async () => {
  const { deps, audits } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "correct-horse-battery" }),
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as { token: string; id: string; role: string; expires_at: string };
    assert.ok(session.token);
    assert.equal(session.id, "user:root");
    assert.equal(session.role, "root");
    assert.ok(!Number.isNaN(Date.parse(session.expires_at)));

    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.deepEqual(await me.json(), { id: "user:root", role: "root", source: "web", signup: true });

    const write = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: MEMORY_BODY,
    });
    assert.equal(write.status, 200);
    assert.deepEqual(await write.json(), { slug: "s", project: "p" });

    const loginAudit = audits.find((a) => a.action === "login");
    assert.ok(loginAudit);
    assert.equal(loginAudit.ok, true);
    const writeAudit = audits.find((a) => a.action === "memory.create");
    assert.ok(writeAudit);
    assert.equal(writeAudit.ok, true);
    assert.equal(writeAudit.actor_id, "user:root");
  } finally {
    await close();
  }
});

test("admin session writes memory (delegated cell honored for authenticated web actors)", async () => {
  const { deps, sessions } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    sessions.set("admin-token", { id: "user:e2e-admin", role: "admin" });
    const write = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer admin-token` },
      body: MEMORY_BODY,
    });
    assert.equal(write.status, 200);

    // A plain `user` role has no cell on memory.create → still 403 even when logged in.
    sessions.set("user-token", { id: "user:reader", role: "user" });
    const denied = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer user-token` },
      body: MEMORY_BODY,
    });
    assert.equal(denied.status, 403);
  } finally {
    await close();
  }
});

test("logout revokes the session; the token stops working", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "correct-horse-battery" }),
    });
    const { token } = (await login.json()) as { token: string };

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(logout.status, 204);

    const write = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: MEMORY_BODY,
    });
    assert.equal(write.status, 401);

    const noBearer = await fetch(`${base}/api/auth/logout`, { method: "POST" });
    assert.equal(noBearer.status, 401);
  } finally {
    await close();
  }
});

test("login with a bad password → 401 and an audited failure", async () => {
  const { deps, audits } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "wrong" }),
    });
    assert.equal(res.status, 401);
    const audit = audits.find((a) => a.action === "login");
    assert.ok(audit);
    assert.equal(audit.ok, false);
  } finally {
    await close();
  }
});

test("CORS reflects a listed Origin and omits the header for an unlisted one", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const listed = await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(listed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(listed.headers.get("vary"), "Origin");

    const preflight = await fetch(`${base}/api/memory`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const unlisted = await fetch(`${base}/api/health`, { headers: { origin: "http://evil.example" } });
    assert.equal(unlisted.headers.get("access-control-allow-origin"), null);

    const noOrigin = await fetch(`${base}/api/health`);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  } finally {
    await close();
  }
});

/* ── register (P3.5 self-service signup) ─────────────────────────────────── */

const REGISTER_HEADERS = { "content-type": "application/json" };

test("POST /api/auth/register → 200 with a usable session token", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: JSON.stringify({ username: "newbie", email: "newbie@x.com", password: "longenoughpw12" }),
    });
    assert.equal(res.status, 200);
    const session = (await res.json()) as { token: string; id: string; role: string; expires_at: string };
    assert.ok(session.token);
    assert.equal(session.id, "user:newbie");
    assert.equal(session.role, "admin"); // first registered user
    assert.ok(!Number.isNaN(Date.parse(session.expires_at)));

    // The returned token is immediately usable.
    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.deepEqual(await me.json(), { id: "user:newbie", role: "admin", source: "web", signup: true });
  } finally {
    await close();
  }
});

test("register conflicts → 409 with a distinguishable error code", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const first = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: JSON.stringify({ username: "alice", email: "alice@x.com", password: "longenoughpw12" }),
    });
    assert.equal(first.status, 200);

    const dupUser = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: JSON.stringify({ username: "alice", email: "other@x.com", password: "longenoughpw12" }),
    });
    assert.equal(dupUser.status, 409);
    assert.equal(((await dupUser.json()) as { error?: string }).error, "username_taken");

    const dupEmail = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: JSON.stringify({ username: "bob", email: "alice@x.com", password: "longenoughpw12" }),
    });
    assert.equal(dupEmail.status, 409);
    assert.equal(((await dupEmail.json()) as { error?: string }).error, "email_taken");
  } finally {
    await close();
  }
});

test("register validation failure → 400", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: JSON.stringify({ username: "alice", email: "alice@x.com", password: "short" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("AITL_WEB_ALLOW_SIGNUP=false → register 403 signup_disabled and me.signup=false", async () => {
  const { deps, audits } = makeFakes();
  const { base, close } = await startServer(deps);
  const prev = process.env.AITL_WEB_ALLOW_SIGNUP;
  process.env.AITL_WEB_ALLOW_SIGNUP = "false";
  try {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: JSON.stringify({ username: "x", email: "x@x.com", password: "longenoughpw12" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error?: string }).error, "signup_disabled");
    const denied = audits.find((a) => a.action === "register");
    assert.ok(denied);
    assert.equal(denied.ok, false);

    const me = await fetch(`${base}/api/auth/me`);
    assert.equal(((await me.json()) as { signup?: boolean }).signup, false);
  } finally {
    if (prev === undefined) delete process.env.AITL_WEB_ALLOW_SIGNUP;
    else process.env.AITL_WEB_ALLOW_SIGNUP = prev;
    await close();
  }
});

/* ── PUT /api/config (P3.5 config panel) ─────────────────────────────────── */

test("PUT /api/config without auth → 401 login_required", async () => {
  const { deps, configCalls } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { MODEL_PRIMARY: "lmstudio" } }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error?: string }).error, "login_required");
    assert.equal(configCalls.length, 0);
  } finally {
    await close();
  }
});

test("PUT /api/config as admin → 200, updates reach applyConfigUpdates, keys audited without values", async () => {
  const { deps, sessions, audits, configCalls } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    sessions.set("admin-token", { id: "user:e2e-admin", role: "admin" });
    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ updates: { MODEL_PRIMARY: "lmstudio", OPENROUTER_API_KEY: null } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(configCalls, [{ MODEL_PRIMARY: "lmstudio", OPENROUTER_API_KEY: null }]);

    const guardAudit = audits.find((a) => a.action === "config_secrets.update");
    assert.ok(guardAudit);
    assert.equal(guardAudit.ok, true);
    const updateAudit = audits.find((a) => a.action === "config.update");
    assert.ok(updateAudit);
    assert.equal(updateAudit.reason, "keys=MODEL_PRIMARY,OPENROUTER_API_KEY");
    // Values (potential secrets) must never land in the audit log.
    assert.ok(!JSON.stringify(audits).includes("lmstudio"));
  } finally {
    await close();
  }
});

test("PUT /api/config as plain user → 403; unknown key → 400 with the known list", async () => {
  const { deps, sessions, configCalls } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    sessions.set("user-token", { id: "user:reader", role: "user" });
    const denied = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer user-token" },
      body: JSON.stringify({ updates: { MODEL_PRIMARY: "lmstudio" } }),
    });
    assert.equal(denied.status, 403);

    sessions.set("admin-token", { id: "user:e2e-admin", role: "admin" });
    const unknown = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ updates: { NOT_A_KEY: "x" } }),
    });
    assert.equal(unknown.status, 400);
    const body = (await unknown.json()) as { error?: string; unknown?: string[]; known?: string[] };
    assert.equal(body.error, "unknown_keys");
    assert.deepEqual(body.unknown, ["NOT_A_KEY"]);
    assert.ok((body.known ?? []).includes("MODEL_PRIMARY"));
    assert.equal(configCalls.length, 0);
  } finally {
    await close();
  }
});

test("GET /api/config/status as admin includes profile, providers and the signup flag", async () => {
  const { deps, sessions } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const anon = await fetch(`${base}/api/config/status`);
    assert.equal(anon.status, 401);

    sessions.set("admin-token", { id: "user:e2e-admin", role: "admin" });
    const res = await fetch(`${base}/api/config/status`, { headers: { authorization: "Bearer admin-token" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      profile?: Record<string, string>;
      providers?: { providers?: unknown[]; active?: string | null };
      signup_enabled?: boolean;
    };
    assert.ok(body.profile);
    assert.ok(Array.isArray(body.providers?.providers));
    assert.equal(typeof body.signup_enabled, "boolean");
  } finally {
    await close();
  }
});

/* ── Setup mode + profiles + admin (ADR-0061) ─────────────────────────────── */

test("GET /api/setup/status needs no auth and reports the loopback flag", async () => {
  const { deps, setSetupState } = makeFakes();
  setSetupState({ setup_required: true, mongo: { ok: true, db: "fake" }, has_real_users: false });
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/setup/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { setup_required?: boolean; loopback?: boolean; mongo?: { ok?: boolean } };
    assert.equal(body.setup_required, true);
    assert.equal(body.loopback, true); // test client connects via 127.0.0.1
    assert.equal(body.mongo?.ok, true);
  } finally {
    await close();
  }
});

test("POST /api/setup/root: creates THE root with a session, then hard-closes", async () => {
  const { deps, setSetupState } = makeFakes();
  setSetupState({ setup_required: true, mongo: { ok: true, db: "fake" }, has_real_users: false });
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/setup/root`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "eversuelo", email: "e@x.com", password: "correct-horse-battery" }),
    });
    assert.equal(res.status, 200);
    const session = (await res.json()) as { token?: string; role?: string; id?: string };
    assert.ok(session.token);
    assert.equal(session.role, "root");
    assert.equal(session.id, "user:eversuelo");

    // The fake flipped has_real_users → setup is closed for good.
    const again = await fetch(`${base}/api/setup/root`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "other", email: "o@x.com", password: "correct-horse-battery" }),
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error?: string }).error, "setup_closed");
  } finally {
    await close();
  }
});

test("setup endpoints reject non-loopback callers with setup_local_only", async () => {
  const { deps, setSetupState } = makeFakes();
  setSetupState({ setup_required: true, mongo: { ok: true, db: "fake" }, has_real_users: false });
  deps.isLoopback = () => false; // simulate a LAN caller
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/setup/root`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "evil", email: "e@lan.com", password: "correct-horse-battery" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error?: string }).error, "setup_local_only");
  } finally {
    await close();
  }
});

test("POST /api/setup/root with Mongo down → 409 mongo_down", async () => {
  const { deps, setSetupState } = makeFakes();
  setSetupState({ setup_required: true, mongo: { ok: false, error: "unreachable" }, has_real_users: null });
  const { base, close } = await startServer(deps);
  try {
    const res = await fetch(`${base}/api/setup/root`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", email: "e@x.com", password: "correct-horse-battery" }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error?: string }).error, "mongo_down");
  } finally {
    await close();
  }
});

test("PUT /api/setup/connection: only while Mongo is down, and only MONGODB_* keys", async () => {
  const { deps, setSetupState, configCalls } = makeFakes();
  setSetupState({ setup_required: true, mongo: { ok: true, db: "fake" }, has_real_users: false });
  const { base, close } = await startServer(deps);
  try {
    // Mongo healthy → the unauthenticated connection write is refused.
    const healthy = await fetch(`${base}/api/setup/connection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { MONGODB_URI: "mongodb://ok-local" } }),
    });
    assert.equal(healthy.status, 409);
    assert.equal(((await healthy.json()) as { error?: string }).error, "mongo_already_ok");

    setSetupState({ setup_required: true, mongo: { ok: false, error: "unreachable" }, has_real_users: null });
    const rejected = await fetch(`${base}/api/setup/connection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { ANTHROPIC_API_KEY: "sk-ant-nope" } }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(((await rejected.json()) as { error?: string }).error, "unknown_keys");

    const ok = await fetch(`${base}/api/setup/connection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { MONGODB_URI: "mongodb://ok-local", MONGODB_DB: "aitl" } }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { keys?: string[]; pending_restart?: string[] };
    assert.deepEqual(body.keys?.sort(), ["MONGODB_DB", "MONGODB_URI"]);
    assert.ok(Array.isArray(body.pending_restart));
    assert.deepEqual(configCalls[0], { MONGODB_URI: "mongodb://ok-local", MONGODB_DB: "aitl" });
  } finally {
    await close();
  }
});

test("POST /api/setup/test-connection probes with the ephemeral client fake", async () => {
  const { deps, setSetupState } = makeFakes();
  setSetupState({ setup_required: true, mongo: { ok: false, error: "down" }, has_real_users: null });
  const { base, close } = await startServer(deps);
  try {
    const good = await fetch(`${base}/api/setup/test-connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "mongodb://ok-host", db: "aitl" }),
    });
    assert.deepEqual(await good.json(), { ok: true, db: "aitl" });
    const bad = await fetch(`${base}/api/setup/test-connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "mongodb://bad-host" }),
    });
    assert.equal(((await bad.json()) as { ok?: boolean }).ok, false);
  } finally {
    await close();
  }
});

test("profiles CRUD: 401 anonymous, 403 plain user, full cycle as root", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "aitl-api-profiles-"));
  const prevHome = process.env.AITL_HOME;
  const prevProfile = process.env.AITL_PROFILE;
  process.env.AITL_HOME = dir;
  delete process.env.AITL_PROFILE;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.AITL_HOME;
    else process.env.AITL_HOME = prevHome;
    if (prevProfile !== undefined) process.env.AITL_PROFILE = prevProfile;
    await rm(dir, { recursive: true, force: true });
  });

  const { deps, sessions } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const anon = await fetch(`${base}/api/profiles`);
    assert.equal(anon.status, 401);

    sessions.set("user-token", { id: "user:plain", role: "user" });
    const denied = await fetch(`${base}/api/profiles/trabajo`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer user-token" },
      body: JSON.stringify({ updates: { MONGODB_DB: "x" } }),
    });
    assert.equal(denied.status, 403);

    sessions.set("root-token", { id: "user:root", role: "root" });
    const auth = { "content-type": "application/json", authorization: "Bearer root-token" };

    const put = await fetch(`${base}/api/profiles/trabajo`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ updates: { MONGODB_DB: "aitl_work", ANTHROPIC_API_KEY: "sk-ant-secret-9999" } }),
    });
    assert.equal(put.status, 200);
    const view = (await put.json()) as Record<string, string>;
    assert.equal(view.MONGODB_DB, "aitl_work");
    assert.equal(view.ANTHROPIC_API_KEY, "••••9999"); // masked view

    const unknown = await fetch(`${base}/api/profiles/trabajo`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ updates: { NOT_A_KEY: "x" } }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as { error?: string }).error, "unknown_keys");

    const list = await fetch(`${base}/api/profiles`, { headers: auth });
    const listBody = (await list.json()) as { active: string | null; profiles: { name: string }[] };
    assert.equal(listBody.active, null);
    assert.deepEqual(listBody.profiles.map((p) => p.name), ["trabajo"]);

    const activate = await fetch(`${base}/api/profiles/active`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "trabajo" }),
    });
    assert.equal(activate.status, 200);
    const activated = (await activate.json()) as { active?: string | null; pending_restart?: string[] };
    assert.equal(activated.active, "trabajo");
    assert.ok(Array.isArray(activated.pending_restart));

    const missing = await fetch(`${base}/api/profiles/active`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "nope" }),
    });
    assert.equal(missing.status, 400);

    // Deleting the active profile is refused; deactivate first, then delete.
    const delActive = await fetch(`${base}/api/profiles/trabajo`, { method: "DELETE", headers: auth });
    assert.equal(delActive.status, 409);
    assert.equal(((await delActive.json()) as { error?: string }).error, "profile_active");

    await fetch(`${base}/api/profiles/active`, { method: "PUT", headers: auth, body: JSON.stringify({ name: null }) });
    const del = await fetch(`${base}/api/profiles/trabajo`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { deleted: true, name: "trabajo" });
  } finally {
    await close();
  }
});

test("POST /api/admin/restart: RBAC-guarded when healthy; loopback exception when Mongo is down", async () => {
  const { deps, sessions, restarts, setSetupState } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    const anon = await fetch(`${base}/api/admin/restart`, { method: "POST" });
    assert.equal(anon.status, 401); // healthy DB → guard applies

    sessions.set("root-token", { id: "user:root", role: "root" });
    const res = await fetch(`${base}/api/admin/restart`, {
      method: "POST",
      headers: { authorization: "Bearer root-token" },
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { restarting?: boolean; will_respawn?: boolean };
    assert.equal(body.restarting, true);
    assert.equal(typeof body.will_respawn, "boolean");
    await new Promise((r) => setTimeout(r, 200)); // requestRestart fires after the response
    assert.equal(restarts.length, 1);

    // Mongo down → the loopback caller may restart without a session (setup flow).
    setSetupState({ setup_required: true, mongo: { ok: false, error: "down" }, has_real_users: null });
    const setupRestart = await fetch(`${base}/api/admin/restart`, { method: "POST" });
    assert.equal(setupRestart.status, 202);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(restarts.length, 2);
  } finally {
    await close();
  }
});

test("POST /api/admin/init-db returns the report to root and denies plain users", async () => {
  const { deps, sessions } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    sessions.set("user-token", { id: "user:plain", role: "user" });
    const denied = await fetch(`${base}/api/admin/init-db`, {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
    });
    assert.equal(denied.status, 403);

    sessions.set("root-token", { id: "user:root", role: "root" });
    const res = await fetch(`${base}/api/admin/init-db`, {
      method: "POST",
      headers: { authorization: "Bearer root-token" },
    });
    assert.equal(res.status, 200);
    const report = (await res.json()) as { db?: string; vector?: { ok?: boolean } };
    assert.equal(report.db, "fake");
    assert.equal(report.vector?.ok, true);
  } finally {
    await close();
  }
});

test("GET /api/config/status now reports sources, profiles and pending_restart", async () => {
  const { deps, sessions } = makeFakes();
  const { base, close } = await startServer(deps);
  try {
    sessions.set("root-token", { id: "user:root", role: "root" });
    const res = await fetch(`${base}/api/config/status`, { headers: { authorization: "Bearer root-token" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sources?: Record<string, string>;
      profiles?: { active: string | null; names: string[] };
      pending_restart?: string[];
      mongo?: { ok?: boolean; db?: string };
    };
    assert.equal(typeof body.sources, "object");
    assert.ok(Array.isArray(body.profiles?.names));
    assert.ok(Array.isArray(body.pending_restart));
    assert.equal(typeof body.mongo?.ok, "boolean");
  } finally {
    await close();
  }
});

test("legacy AITL_WEB_TOKENS map still resolves an actor", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  const prev = process.env.AITL_WEB_TOKENS;
  process.env.AITL_WEB_TOKENS = JSON.stringify({ "legacy-token": { id: "web:ci", role: "root" } });
  try {
    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer legacy-token" } });
    assert.deepEqual(await me.json(), { id: "web:ci", role: "root", source: "web", signup: true });

    const write = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer legacy-token" },
      body: MEMORY_BODY,
    });
    assert.equal(write.status, 200);

    // An unknown token is unauthenticated → writes still 401 with login_required.
    const unknown = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: MEMORY_BODY,
    });
    assert.equal(unknown.status, 401);
    assert.equal(((await unknown.json()) as { error?: string }).error, "login_required");
  } finally {
    if (prev === undefined) delete process.env.AITL_WEB_TOKENS;
    else process.env.AITL_WEB_TOKENS = prev;
    await close();
  }
});
