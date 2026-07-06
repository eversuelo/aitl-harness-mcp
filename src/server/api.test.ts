import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Role } from "../auth/rbac.js";
import { type ApiDeps, createApiServer } from "./api.js";

type AuditRecord = Parameters<ApiDeps["audit"]>[0];

/** In-memory fakes for every effect-ful dependency, so no Mongo/embedder is touched. */
function makeFakes() {
  const sessions = new Map<string, { id: string; role: Role }>();
  const audits: AuditRecord[] = [];
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
    audit: async (ev) => {
      audits.push(ev);
    },
    upsertMemory: async (body) => ({ slug: String(body.slug ?? ""), project: String(body.project ?? "") }),
  };
  return { deps, sessions, audits };
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
    assert.deepEqual(await me.json(), { id: "user:root", role: "root", source: "web" });

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

test("legacy AITL_WEB_TOKENS map still resolves an actor", async () => {
  const { deps } = makeFakes();
  const { base, close } = await startServer(deps);
  const prev = process.env.AITL_WEB_TOKENS;
  process.env.AITL_WEB_TOKENS = JSON.stringify({ "legacy-token": { id: "web:ci", role: "root" } });
  try {
    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer legacy-token" } });
    assert.deepEqual(await me.json(), { id: "web:ci", role: "root", source: "web" });

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
