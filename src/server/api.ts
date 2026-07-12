/**
 * Memory-admin HTTP API.
 *
 * A dependency-free `node:http` server exposing CRUD + search over the durable
 * memory bank. It is a thin REST projection of `MemoryStore` (the same gateway the
 * MCP server and CLI use), so the web UI never touches Mongo directly and writes go
 * through the identical classify→embed→upsert path as `write_memory`.
 *
 * Routes (all JSON):
 *   GET    /api/health
 *   POST   /api/auth/login                   {username,password} → {token,id,role,expires_at}
 *   POST   /api/auth/register                {username,email,password} → session (gated by AITL_WEB_ALLOW_SIGNUP)
 *   POST   /api/auth/logout                  (Bearer) revoke session → 204
 *   GET    /api/auth/me                      resolved actor identity (+ signup flag)
 *   GET    /api/config                      effective profile (secrets masked)
 *   GET    /api/config/status               profile + sources + providers + profiles + pending_restart
 *   PUT    /api/config                       {updates:{KEY: value|null}} → profile + .env mirror
 *   GET    /api/setup/status                 (no auth) setup mode + mongo probe + loopback flag
 *   POST   /api/setup/root                   (setup+loopback) create THE root → session
 *   POST   /api/setup/test-connection        (setup+loopback) probe a candidate URI (ephemeral client)
 *   PUT    /api/setup/connection             (mongo down+loopback) persist MONGODB_* keys only
 *   GET    /api/profiles                     named profiles list + active
 *   PUT    /api/profiles/active              {name|null} → {active, pending_restart}
 *   GET/PUT/DELETE /api/profiles/:name       one profile (masked view / upsert / delete)
 *   POST   /api/admin/restart                clean exit-75 shutdown (respawned by `aitl ui --watch-restart`)
 *   POST   /api/admin/init-db                idempotent collections/indexes bootstrap → report
 *   POST   /api/admin/test-connection        authenticated mirror of setup/test-connection
 *   GET    /api/projects
 *   GET    /api/memory?project=&category=&type=&limit=
 *   GET    /api/memory/search?project=&q=&limit=
 *   GET    /api/memory/:slug?project=
 *   POST   /api/memory                       {project,slug,body,description,type,tags}
 *   PUT    /api/memory/:slug                 (same body; upsert)
 *   DELETE /api/memory/:slug?project=
 *   GET    /api/runs?project=&limit=         run telemetry (tokens, cost, iters, status)
 *   GET    /api/runs/:id                     one run + event counts + supervision minutes
 *   GET    /api/tool-calls?project=&since=   mcp_tool_calls aggregation: per tool, volume/
 *                                            success/latency + read-vs-write + what it hydrated/created
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { Server } from "node:http";
import { MEMORY_TYPES, RESERVED_MEMORY_TYPES, type MemoryType } from "../memory/schemas.js";
import { makeMemoryDoc } from "../models/memory.model.js";
import { recordAudit } from "../auth/audit.js";
import { createSession, resolveSession, revokeSession } from "../auth/sessions.js";
import type { VerifyUserResult } from "../auth/users.js";
import { resolvedEnv } from "../config/store.js";
import { isLoopback, type MongoProbe, type SetupStatus } from "./setup.js";
import {
  type AccessContext,
  type Action,
  type Actor,
  type Resource,
  type Role,
  can,
  isRole,
} from "../auth/rbac.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

const DEFAULT_WEB_ORIGINS = "http://localhost:5173,http://localhost:4173";

/** Effect-ful collaborators of the API, injectable so tests run without Mongo. */
export interface ApiDeps {
  resolveSession: (token: string) => Promise<{ id: string; role: Role; source: "web" } | null>;
  createSession: (userId: string, role: string, ttlMs?: number) => Promise<{ token: string; expiresAt: Date }>;
  revokeSession: (token: string) => Promise<boolean>;
  verifyCredentials: (username: string, password: string) => Promise<VerifyUserResult>;
  /** Self-service signup (P3.5). Throws RegistrationConflictError on duplicates. */
  registerUser: (seed: { username: string; email: string; password: string }) => Promise<{ username: string; role: string }>;
  /** Double persistence: ~/.aitl/config.json + project .env mirror (P3.5). */
  applyConfigUpdates: (updates: Record<string, string | null>) => Promise<{ profilePath: string; envPath: string; keys: string[] }>;
  audit: typeof recordAudit;
  upsertMemory: (body: Record<string, unknown>, actor?: Actor) => Promise<Record<string, unknown>>;
  // ── First-boot setup + guided restart (ADR-0061) ──────────────────────────
  /** Probe the ACTIVE connection + real-user count (setup mode detection). */
  setupStatus: () => Promise<SetupStatus>;
  /** Create THE root account while no real user exists (throws SetupClosedError after). */
  createSetupRoot: (seed: { username: string; email: string; password: string }) => Promise<{ username: string; role: string }>;
  /** Try a candidate URI with an ephemeral client (never the live connection). */
  probeMongo: (uri: string, db?: string) => Promise<MongoProbe>;
  /** Loopback check for the unauthenticated setup surface. */
  isLoopback: (req: IncomingMessage) => boolean;
  /** Ask the host process for a clean exit-75 shutdown (wired by `aitl ui`). */
  requestRestart: () => void;
  /** Idempotent collections/indexes bootstrap (POST /api/admin/init-db). */
  runInitDb: () => Promise<unknown>;
  /** Built SPA root (web/dist) to serve on non-/api GETs; null = API only. */
  staticDir?: string | null;
}

/**
 * Self-service signup gate: on by default; AITL_WEB_ALLOW_SIGNUP="false"/"0" turns it
 * off. Read through the layered resolution (ADR-0061) so profiles/config.json apply
 * without needing the key in the real env.
 */
function signupEnabled(): boolean {
  return !/^(false|0)$/i.test((resolvedEnv("AITL_WEB_ALLOW_SIGNUP") ?? "").trim());
}

/**
 * Default credential verifier: `verifyUserCredentials` keys on username+email, but the
 * web login form only asks for a username — so resolve the account's email first.
 */
async function verifyWebCredentials(username: string, password: string): Promise<VerifyUserResult> {
  const { verifyUserCredentials } = await import("../auth/users.js");
  const { UserModel } = await import("../models/user.model.js");
  const { ensureMongoose } = await import("../db/mongoose.js");
  await ensureMongoose();
  const account = await UserModel.findOne({ username: username.trim().toLowerCase() }, { email: 1 }).lean();
  if (!account) return { ok: false, reason: "user not found" };
  return verifyUserCredentials({ username, email: String(account.email ?? ""), password });
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/**
 * Resolve the calling actor. The web client never holds Mongo credentials; it presents
 * a bearer token resolved through a cascade:
 *   1. login session (Mongo-backed, `POST /api/auth/login`);
 *   2. the static `AITL_WEB_TOKENS` env map (legacy compat,
 *      JSON: { "<token>": { "id": "...", "role": "..." } });
 *   3. anonymous `user` (least privilege) — writes then 401 with `login_required`.
 */
async function resolveActor(req: IncomingMessage, deps: ApiDeps): Promise<Actor> {
  const token = bearerToken(req);
  if (!token) return { id: "web:anonymous", role: "user", source: "web" };
  // Session lookup failures (e.g. Mongo unreachable) fall through to the legacy map.
  const session = await deps.resolveSession(token).catch(() => null);
  if (session) return session;
  try {
    const map = JSON.parse(process.env.AITL_WEB_TOKENS ?? "{}") as Record<string, { id?: string; role?: string }>;
    const entry = map[token];
    if (entry && isRole(entry.role)) {
      return { id: entry.id ?? "web:unknown", role: entry.role as Role, source: "web" };
    }
  } catch {
    /* malformed token map → fall through to anonymous */
  }
  return { id: "web:unauthenticated", role: "user", source: "web" };
}

/** Web callers that presented no (or no valid) credential — as opposed to a logged-in actor. */
function isUnauthenticated(actor: Actor): boolean {
  return actor.source === "web" && (actor.id === "web:anonymous" || actor.id === "web:unauthenticated");
}

/**
 * RBAC guard + audit; records both outcomes. On denial throws 401 (`login_required`)
 * for an unauthenticated caller — so the UI can prompt for login — and 403 for an
 * authenticated actor whose role lacks the permission.
 *
 * Authenticated web writes count as delegated: the API server mediates and stamps the
 * actor identity, the same trust model under which `guardTool` (MCP server) passes
 * `delegated: true` — otherwise every "delegated" cell (e.g. admin on memory) would
 * deny the web UI even after login.
 */
async function guard(
  deps: ApiDeps,
  actor: Actor,
  resource: Resource,
  action: Action,
  ctx: AccessContext = {},
): Promise<void> {
  const decision = can(actor, resource, action, { delegated: !isUnauthenticated(actor), ...ctx });
  await deps.audit({
    actor_id: actor.id,
    actor_role: actor.role,
    source: "web",
    action: `${resource}.${action}`,
    resource,
    resource_owner: ctx.ownerId,
    ok: decision.allow,
    reason: decision.reason,
  });
  if (!decision.allow) {
    if (isUnauthenticated(actor)) {
      throw new HttpError(401, decision.reason, { error: "login_required", hint: "POST /api/auth/login" });
    }
    throw new HttpError(403, decision.reason);
  }
}

/**
 * CORS: reflect the request Origin only when it is in the `AITL_WEB_ORIGINS` allowlist
 * (CSV; defaults to the Vite dev/preview ports). No Origin header (curl, same-origin)
 * or an unlisted Origin → no CORS headers at all (the browser then blocks the caller).
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {};
  const allowed = (resolvedEnv("AITL_WEB_ORIGINS") ?? DEFAULT_WEB_ORIGINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...jsonHeaders, ...corsHeaders(req) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

/** Reuse the MCP `write_memory` contract: classify + embed + upsert one doc. */
async function upsertMemoryDoc(body: Record<string, unknown>, actor?: Actor): Promise<Record<string, unknown>> {
  const { embedOne } = await import("../ingest/embedder.js");
  const { extractLinks } = await import("../ingest/markdown.js");
  const { Classifier } = await import("../memory/classifier.js");
  const { MemoryStore } = await import("../memory/store.js");

  const project = String(body.project ?? "");
  const slug = String(body.slug ?? "");
  if (!project || !slug) throw new HttpError(400, "`project` and `slug` are required.");

  const rawType = String(body.type ?? "project");
  const type: MemoryType =
    (MEMORY_TYPES as readonly string[]).includes(rawType) && !RESERVED_MEMORY_TYPES.has(rawType)
      ? (rawType as MemoryType)
      : "project";
  const text = String(body.body ?? "");
  const doc = await makeMemoryDoc({
    project,
    slug,
    type,
    description: String(body.description ?? ""),
    body: text,
    links: extractLinks(text),
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
  });
  await new Classifier().classifyMemory(doc);
  doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
  await new MemoryStore().upsertMemory(doc, actor ? { actor: { id: actor.id, role: actor.role } } : {});
  return { slug: doc.slug, project: doc.project, category: doc.category, type: doc.type, version: doc.version };
}

/** Parse a `limit` query param defensively: NaN/negative/absent → default, always ≤ max.
 *  Mongoose treats `.limit(NaN)` as "no limit", which would let `?limit=abc` stream a
 *  whole collection through the unauthenticated read routes. */
function parseLimit(searchParams: URLSearchParams, def: number, max = 500): number {
  const n = Number(searchParams.get("limit") ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Optional structured response body (e.g. { error: "login_required", hint }). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname, searchParams } = url;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return send(req, res, 204, {});
  if (pathname === "/api/health") return send(req, res, 200, { ok: true });

  // ── First-boot setup surface (ADR-0061) — unauthenticated, loopback-only ────
  // Sessions live in Mongo, so a fresh (or unreachable) DB has nothing to log in
  // with; this minimal surface lets the local operator bootstrap. It hard-closes
  // as soon as a real user exists (`setup_closed`).
  const requireSetupMode = async (opts: { requireMongoDown?: boolean } = {}): Promise<SetupStatus> => {
    if (!deps.isLoopback(req)) {
      throw new HttpError(403, "setup endpoints are restricted to loopback callers", {
        error: "setup_local_only",
      });
    }
    const status = await deps.setupStatus();
    if (!status.setup_required) {
      throw new HttpError(409, "setup already completed: a real user exists", { error: "setup_closed" });
    }
    if (opts.requireMongoDown && status.mongo.ok) {
      throw new HttpError(409, "connection already works; use the authenticated config API", {
        error: "mongo_already_ok",
      });
    }
    return status;
  };

  if (pathname === "/api/setup/status" && method === "GET") {
    const status = await deps.setupStatus();
    return send(req, res, 200, { ...status, loopback: deps.isLoopback(req) });
  }

  if (pathname === "/api/setup/root" && method === "POST") {
    const status = await requireSetupMode();
    if (!status.mongo.ok) {
      throw new HttpError(409, "MongoDB is unreachable; configure the connection first", {
        error: "mongo_down",
        mongo: status.mongo,
      });
    }
    const body = await readJson(req);
    let created: { username: string; role: string };
    try {
      created = await deps.createSetupRoot({
        username: String(body.username ?? ""),
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
      });
    } catch (err) {
      // Structural detection so injected fakes don't need the exact classes.
      if ((err as { name?: string }).name === "SetupClosedError") {
        throw new HttpError(409, "setup already completed: a real user exists", { error: "setup_closed" });
      }
      const conflict = (err as { conflict?: string }).conflict;
      if (conflict === "username" || conflict === "email") {
        throw new HttpError(409, `${conflict} taken`, { error: `${conflict}_taken` });
      }
      throw new HttpError(400, err instanceof Error ? err.message : String(err), { error: "invalid_setup" });
    }
    if (!isRole(created.role)) throw new HttpError(500, "setup user has an invalid role");
    // Same shape as login: the wizard continues authenticated as this root.
    const userId = `user:${created.username}`;
    const session = await deps.createSession(userId, created.role);
    return send(req, res, 200, {
      token: session.token,
      id: userId,
      role: created.role,
      expires_at: session.expiresAt.toISOString(),
    });
  }

  if (pathname === "/api/setup/test-connection" && method === "POST") {
    await requireSetupMode();
    const body = await readJson(req);
    const uri = String(body.uri ?? "");
    if (!uri) throw new HttpError(400, "`uri` is required.");
    return send(req, res, 200, await deps.probeMongo(uri, body.db ? String(body.db) : undefined));
  }

  // Step 0 of the wizard (Mongo unreachable): persist ONLY the connection keys so
  // the guided restart can boot against the fixed URI. Audited best-effort (the
  // audit trail itself needs Mongo).
  if (pathname === "/api/setup/connection" && method === "PUT") {
    await requireSetupMode({ requireMongoDown: true });
    const body = await readJson(req);
    const raw = body.updates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(400, "`updates` object is required: { KEY: value | null }.");
    }
    const MONGO_KEYS = ["MONGODB_URI", "MONGODB_URI_FALLBACK", "MONGODB_DB"];
    const updates: Record<string, string | null> = {};
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!MONGO_KEYS.includes(k)) rejected.push(k);
      else updates[k] = v == null ? null : String(v);
    }
    if (rejected.length) {
      throw new HttpError(400, `Only connection keys are allowed here: ${MONGO_KEYS.join(", ")}`, {
        error: "unknown_keys",
        unknown: rejected,
        known: MONGO_KEYS,
      });
    }
    if (!Object.keys(updates).length) throw new HttpError(400, "`updates` is empty.");
    await deps.applyConfigUpdates(updates);
    console.warn(`[api] setup: connection keys written from loopback (${Object.keys(updates).join(", ")})`);
    const { pendingRestartKeys } = await import("../config/store.js");
    return send(req, res, 200, { keys: Object.keys(updates), pending_restart: pendingRestartKeys() });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readJson(req);
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    let result: VerifyUserResult;
    try {
      result = await deps.verifyCredentials(username, password);
    } catch (err) {
      // Verifier validation errors (bad format, etc.) are credential failures, not 500s.
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const userId = `user:${result.username ?? (username || "unknown")}`;
    await deps.audit({
      actor_id: userId,
      actor_role: result.ok ? String(result.role) : "user",
      source: "web",
      action: "login",
      resource: "users",
      ok: result.ok,
      reason: result.reason,
    });
    if (!result.ok || !isRole(result.role)) {
      throw new HttpError(401, result.reason ?? "invalid credentials", { error: "invalid_credentials" });
    }
    const session = await deps.createSession(userId, result.role);
    return send(req, res, 200, {
      token: session.token,
      id: userId,
      role: result.role,
      expires_at: session.expiresAt.toISOString(),
    });
  }

  if (pathname === "/api/auth/register" && method === "POST") {
    if (!signupEnabled()) {
      await deps.audit({
        actor_id: "web:anonymous",
        actor_role: "user",
        source: "web",
        action: "register",
        resource: "users",
        ok: false,
        reason: "signup disabled (AITL_WEB_ALLOW_SIGNUP)",
      });
      throw new HttpError(403, "signup is disabled on this server", { error: "signup_disabled" });
    }
    const body = await readJson(req);
    let created: { username: string; role: string };
    try {
      created = await deps.registerUser({
        username: String(body.username ?? ""),
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
      });
    } catch (err) {
      // RegistrationConflictError carries the offending field; detected structurally so
      // injected fakes don't need the exact class instance.
      const conflict = (err as { conflict?: string }).conflict;
      if (conflict === "username" || conflict === "email") {
        throw new HttpError(409, `${conflict} taken`, { error: `${conflict}_taken` });
      }
      throw new HttpError(400, err instanceof Error ? err.message : String(err), { error: "invalid_registration" });
    }
    if (!isRole(created.role)) throw new HttpError(500, "registered user has an invalid role");
    // Same shape as login: the fresh account is signed in right away.
    const userId = `user:${created.username}`;
    const session = await deps.createSession(userId, created.role);
    return send(req, res, 200, {
      token: session.token,
      id: userId,
      role: created.role,
      expires_at: session.expiresAt.toISOString(),
    });
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, "bearer token required", { error: "login_required", hint: "POST /api/auth/login" });
    await deps.revokeSession(token);
    return send(req, res, 204, {});
  }

  const actor = await resolveActor(req, deps);
  if (pathname === "/api/auth/me" && method === "GET") {
    // `signup` lets the login dialog hide the "create account" mode when disabled.
    return send(req, res, 200, { id: actor.id, role: actor.role, source: actor.source, signup: signupEnabled() });
  }

  if (pathname === "/api/config" && method === "GET") {
    // Secrets are masked by resolveProfile; root (or admin via web, delegated) only.
    await guard(deps, actor, "config_secrets", "read");
    const { resolveProfile } = await import("../config/store.js");
    return send(req, res, 200, resolveProfile());
  }

  // Config panel snapshot: masked profile + provider status + signup flag, plus
  // (ADR-0061) per-key provenance, named profiles, pending-restart diff and a
  // cheap Mongo state (readyState only — the wizard uses /api/setup/status for
  // the authoritative probe).
  if (pathname === "/api/config/status" && method === "GET") {
    await guard(deps, actor, "config_secrets", "read");
    const { resolveProfile, resolveProfileSources, pendingRestartKeys, activeProfileName } =
      await import("../config/store.js");
    const { listProfiles } = await import("../config/profiles.js");
    const { providerStatus } = await import("../providers/base.js");
    const { settings } = await import("../config.js");
    const mongoose = (await import("mongoose")).default;
    return send(req, res, 200, {
      profile: resolveProfile(),
      sources: resolveProfileSources(),
      providers: providerStatus(),
      signup_enabled: signupEnabled(),
      profiles: { active: activeProfileName(), names: listProfiles().map((p) => p.name) },
      pending_restart: pendingRestartKeys(),
      mongo: { ok: mongoose.connection.readyState === 1, db: settings.mongodbDb },
    });
  }

  if (pathname === "/api/config" && method === "PUT") {
    await guard(deps, actor, "config_secrets", "update");
    const body = await readJson(req);
    const raw = body.updates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(400, "`updates` object is required: { KEY: value | null }.");
    }
    const { ENV_KEYS, resolveProfile } = await import("../config/store.js");
    const updates: Record<string, string | null> = {};
    const unknown: string[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(ENV_KEYS as readonly string[]).includes(k)) unknown.push(k);
      else updates[k] = v == null ? null : String(v);
    }
    if (unknown.length) {
      throw new HttpError(400, `Unknown config key(s): ${unknown.join(", ")}`, {
        error: "unknown_keys",
        unknown,
        known: [...ENV_KEYS],
      });
    }
    if (!Object.keys(updates).length) throw new HttpError(400, "`updates` is empty.");
    await deps.applyConfigUpdates(updates);
    // Audit which keys were touched — never the values (several are secrets).
    await deps.audit({
      actor_id: actor.id,
      actor_role: actor.role,
      source: "web",
      action: "config.update",
      resource: "config_secrets",
      ok: true,
      reason: `keys=${Object.keys(updates).join(",")}`,
    });
    return send(req, res, 200, resolveProfile());
  }

  // ── Named profiles (ADR-0061) — same trust as config_secrets ───────────────
  if (pathname === "/api/profiles" && method === "GET") {
    await guard(deps, actor, "config_secrets", "read");
    const { listProfiles } = await import("../config/profiles.js");
    const { activeProfileName } = await import("../config/store.js");
    return send(req, res, 200, { active: activeProfileName(), profiles: listProfiles() });
  }

  if (pathname === "/api/profiles/active" && method === "PUT") {
    await guard(deps, actor, "config_secrets", "update");
    const body = await readJson(req);
    const name = body.name == null || body.name === "" ? null : String(body.name);
    const { setActiveProfile } = await import("../config/profiles.js");
    const { activeProfileName, pendingRestartKeys } = await import("../config/store.js");
    try {
      await setActiveProfile(name);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), { error: "invalid_profile" });
    }
    await deps.audit({
      actor_id: actor.id,
      actor_role: actor.role,
      source: "web",
      action: "config.profile_activate",
      resource: "config_secrets",
      ok: true,
      reason: `name=${name ?? "(none)"}`,
    });
    return send(req, res, 200, { active: activeProfileName(), pending_restart: pendingRestartKeys() });
  }

  const profileRoute = /^\/api\/profiles\/([^/]+)$/.exec(pathname);
  if (profileRoute && method === "GET") {
    await guard(deps, actor, "config_secrets", "read");
    const { resolveProfileView } = await import("../config/profiles.js");
    try {
      return send(req, res, 200, resolveProfileView(decodeURIComponent(profileRoute[1])));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), { error: "invalid_profile" });
    }
  }
  if (profileRoute && method === "PUT") {
    await guard(deps, actor, "config_secrets", "update");
    const name = decodeURIComponent(profileRoute[1]);
    const body = await readJson(req);
    const raw = body.updates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(400, "`updates` object is required: { KEY: value | null }.");
    }
    const updates: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      updates[k] = v == null ? null : String(v);
    }
    const { writeProfile, resolveProfileView } = await import("../config/profiles.js");
    try {
      await writeProfile(name, updates); // validates name + keys (unknown keys throw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { ENV_KEYS } = await import("../config/store.js");
      if (/Unknown config key/.test(message)) {
        throw new HttpError(400, message, { error: "unknown_keys", known: [...ENV_KEYS] });
      }
      throw new HttpError(400, message, { error: "invalid_profile" });
    }
    await deps.audit({
      actor_id: actor.id,
      actor_role: actor.role,
      source: "web",
      action: "config.profile_update",
      resource: "config_secrets",
      ok: true,
      reason: `name=${name} keys=${Object.keys(updates).join(",")}`,
    });
    return send(req, res, 200, resolveProfileView(name));
  }
  if (profileRoute && method === "DELETE") {
    await guard(deps, actor, "config_secrets", "update");
    const name = decodeURIComponent(profileRoute[1]);
    const { deleteProfile } = await import("../config/profiles.js");
    let deleted: boolean;
    try {
      deleted = await deleteProfile(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/is active/.test(message)) throw new HttpError(409, message, { error: "profile_active" });
      throw new HttpError(400, message, { error: "invalid_profile" });
    }
    await deps.audit({
      actor_id: actor.id,
      actor_role: actor.role,
      source: "web",
      action: "config.profile_delete",
      resource: "config_secrets",
      ok: true,
      reason: `name=${name} deleted=${deleted}`,
    });
    return send(req, res, deleted ? 200 : 404, { deleted, name });
  }

  // ── Process admin: guided restart + explicit init-db (ADR-0061) ────────────
  if (pathname === "/api/admin/restart" && method === "POST") {
    const status = await deps.setupStatus();
    // Exception: with Mongo down there is nothing to authenticate against
    // (sessions live in Mongo) — a loopback caller in setup mode may restart
    // after fixing the connection. Everyone else goes through RBAC.
    if (status.mongo.ok || !deps.isLoopback(req)) {
      await guard(deps, actor, "server_admin", "execute");
    } else {
      console.warn("[api] restart requested from loopback in setup mode (mongo down)");
    }
    const willRespawn = process.env.AITL_UI_SUPERVISED === "1";
    send(req, res, 202, { restarting: true, will_respawn: willRespawn });
    // Response is flushed; the graceful shutdown waits for in-flight requests.
    setTimeout(() => deps.requestRestart(), 100);
    return;
  }

  if (pathname === "/api/admin/init-db" && method === "POST") {
    await guard(deps, actor, "server_admin", "execute");
    return send(req, res, 200, await deps.runInitDb());
  }

  if (pathname === "/api/admin/test-connection" && method === "POST") {
    await guard(deps, actor, "server_admin", "execute");
    const body = await readJson(req);
    const uri = String(body.uri ?? "");
    if (!uri) throw new HttpError(400, "`uri` is required.");
    return send(req, res, 200, await deps.probeMongo(uri, body.db ? String(body.db) : undefined));
  }

  const { MemoryStore } = await import("../memory/store.js");
  const store = new MemoryStore();

  if (pathname === "/api/projects" && method === "GET") {
    return send(req, res, 200, await store.listProjects());
  }

  // ── graph (durable-state projection) ──────────────────────────────────────
  if (pathname === "/api/graph" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const scope = (searchParams.get("scope") ?? "all") as "all" | "symbols" | "memory";
    const { graphify, MongoGraphSource } = await import("../graph/index.js");
    const graphs = await graphify(new MongoGraphSource(store.db), { project, scope });
    return send(req, res, 200, graphs[project] ?? { nodes: [], edges: [] });
  }

  // ── knowledge map (multi-entity projection, ADR-0029) ─────────────────────
  if (pathname === "/api/knowledge-graph" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const { knowledgeGraphify, KNOWLEDGE_ENTITIES, MongoGraphSource } = await import("../graph/index.js");
    const raw = searchParams.get("entities");
    const entities = raw
      ? (raw.split(",").map((s) => s.trim()).filter((s) => (KNOWLEDGE_ENTITIES as string[]).includes(s)) as typeof KNOWLEDGE_ENTITIES)
      : undefined;
    const graph = await knowledgeGraphify(new MongoGraphSource(store.db), { project, entities });
    return send(req, res, 200, graph);
  }

  if (pathname === "/api/memory/search" && method === "GET") {
    const project = searchParams.get("project") ?? undefined;
    const q = searchParams.get("q") ?? "";
    const limit = parseLimit(searchParams, 20);
    const { embedOne } = await import("../ingest/embedder.js");
    let hits: unknown[];
    try {
      hits = await store.vectorSearch("memory", await embedOne(q), { project, limit });
    } catch {
      hits = await store.textSearch("memory", q, { project, limit });
    }
    return send(req, res, 200, hits);
  }

  if (pathname === "/api/memory" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    return send(req, res, 200, await store.listMemory(project, {
      category: searchParams.get("category") ?? undefined,
      type: searchParams.get("type") ?? undefined,
      limit: parseLimit(searchParams, 200),
    }));
  }

  if (pathname === "/api/memory" && (method === "POST" || method === "PUT")) {
    await guard(deps, actor, "memory", method === "POST" ? "create" : "update");
    return send(req, res, 200, await deps.upsertMemory(await readJson(req), actor));
  }

  // /api/memory/:slug  (GET | PUT | DELETE)
  const m = /^\/api\/memory\/([^/]+)$/.exec(pathname);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    if (method === "GET") {
      const project = searchParams.get("project");
      if (!project) throw new HttpError(400, "`project` query param is required.");
      const doc = await store.getMemory(project, slug);
      if (!doc) throw new HttpError(404, `No memory '${slug}' in project '${project}'.`);
      return send(req, res, 200, doc);
    }
    if (method === "PUT") {
      await guard(deps, actor, "memory", "update");
      return send(req, res, 200, await deps.upsertMemory({ ...(await readJson(req)), slug }, actor));
    }
    if (method === "DELETE") {
      await guard(deps, actor, "memory", "delete");
      const project = searchParams.get("project");
      if (!project) throw new HttpError(400, "`project` query param is required.");
      const ok = await store.deleteMemory(project, slug);
      return send(req, res, ok ? 200 : 404, { deleted: ok, slug, project });
    }
  }

  // ── decisions / ADRs ──────────────────────────────────────────────────────
  if (pathname === "/api/decisions" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const rows = await store.db
      .collection("decisions")
      .find({ project }, { projection: { embedding: 0 } })
      .sort({ id: 1 })
      .toArray();
    return send(req, res, 200, rows);
  }

  const d = /^\/api\/decisions\/([^/]+)$/.exec(pathname);
  if (d && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const id = decodeURIComponent(d[1]);
    const doc = await store.db
      .collection("decisions")
      .findOne({ project, id }, { projection: { embedding: 0 } });
    if (!doc) throw new HttpError(404, `No decision '${id}' in project '${project}'.`);
    return send(req, res, 200, doc);
  }

  // ── context snapshots (mcp_context) ───────────────────────────────────────
  if (pathname === "/api/context" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const query: Record<string, unknown> = { project };
    const repo = searchParams.get("repo");
    if (repo) query.repo = repo;
    const { ensureMongoose } = await import("../db/mongoose.js");
    const { McpContextModel } = await import("../models/mcpContext.model.js");
    await ensureMongoose();
    const rows = await McpContextModel.find(query, { messages: 0, context: 0 })
      .sort({ created_at: -1 })
      .limit(parseLimit(searchParams, 100))
      .lean();
    return send(req, res, 200, rows);
  }

  const ctx = /^\/api\/context\/([^/]+)$/.exec(pathname);
  if (ctx && method === "GET") {
    const id = decodeURIComponent(ctx[1]);
    const { ensureMongoose } = await import("../db/mongoose.js");
    const { McpContextModel } = await import("../models/mcpContext.model.js");
    await ensureMongoose();
    const doc = await McpContextModel.findOne({ context_id: id }).lean();
    if (!doc) throw new HttpError(404, `No context '${id}'.`);
    return send(req, res, 200, doc);
  }

  // ── software / repo catalog (ADR-0028) ────────────────────────────────────
  if (pathname === "/api/softwares" && method === "GET") {
    const { SoftwareStore } = await import("../softwares/store.js");
    return send(req, res, 200, await new SoftwareStore().list({ limit: 200 }));
  }
  if (pathname === "/api/repos" && method === "GET") {
    const { RepoStore } = await import("../repos/store.js");
    const project = searchParams.get("project") ?? undefined;
    const software = searchParams.get("software") ?? undefined;
    return send(req, res, 200, await new RepoStore().list({ project, software, limit: 200 }));
  }
  if (pathname === "/api/branches" && method === "GET") {
    const { BranchStore } = await import("../branches/store.js");
    const project = searchParams.get("project") ?? undefined;
    const repo = searchParams.get("repo") ?? undefined;
    const kind = searchParams.get("kind") ?? undefined;
    return send(req, res, 200, await new BranchStore().list({ project, repo, kind, limit: 500 }));
  }

  // ── runs (measured telemetry: tokens, cost, iters, tool calls, status) ──────
  if (pathname === "/api/runs" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const { ensureMongoose } = await import("../db/mongoose.js");
    const { RunModel } = await import("../models/run.model.js");
    await ensureMongoose();
    const rows = await RunModel.find({ project })
      .sort({ started_at: -1 })
      .limit(parseLimit(searchParams, 200))
      .lean();
    return send(req, res, 200, rows);
  }

  // ── tool-calls telemetry (which MCP tools ran, what they hydrated/created) ─
  if (pathname === "/api/tool-calls" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const { ensureMongoose } = await import("../db/mongoose.js");
    const { toolCallsReport } = await import("../toolcalls/report.js");
    await ensureMongoose();
    const since = searchParams.get("since");
    const match: Record<string, unknown> = { project };
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) match.ts = { $gte: d };
    }
    return send(req, res, 200, await toolCallsReport(match));
  }

  // Per-session graph (ADR-0035): the run linked to the ADRs/memories/prompts it produced.
  const rg = /^\/api\/runs\/([^/]+)\/graph$/.exec(pathname);
  if (rg && method === "GET") {
    const id = decodeURIComponent(rg[1]);
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const { sessionGraph } = await import("../graph/session.js");
    const graph = await sessionGraph(store.db, project, id, { temporal: searchParams.get("temporal") === "1" });
    if (!graph) throw new HttpError(404, `No run '${id}'.`);
    return send(req, res, 200, graph);
  }

  const rr = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (rr && method === "GET") {
    const id = decodeURIComponent(rr[1]);
    const { ensureMongoose } = await import("../db/mongoose.js");
    const { RunModel } = await import("../models/run.model.js");
    await ensureMongoose();
    const run = await RunModel.findOne({ _id: id }).lean();
    if (!run) throw new HttpError(404, `No run '${id}'.`);
    const events = await store.db.collection("events").find({ run_id: id }).toArray();
    const byType: Record<string, number> = {};
    let interventionMinutes = 0;
    for (const e of events) {
      const t = String(e.type);
      byType[t] = (byType[t] ?? 0) + 1;
      if (t === "human_intervention") interventionMinutes += Number((e.payload as Record<string, unknown>)?.minutes ?? 0);
    }
    return send(req, res, 200, { run, event_counts: byType, intervention_minutes: interventionMinutes });
  }

  // ── prompt history ────────────────────────────────────────────────────────
  if (pathname === "/api/prompts" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const { PromptStore } = await import("../prompts/store.js");
    const rows = await new PromptStore().list(project, {
      limit: parseLimit(searchParams, 200),
    });
    return send(req, res, 200, rows);
  }

  // DELETE /api/prompts/:id  — owner, admin or root (per RBAC "own" rule)
  const pd = /^\/api\/prompts\/([^/]+)$/.exec(pathname);
  if (pd && method === "DELETE") {
    const id = decodeURIComponent(pd[1]);
    const { PromptStore } = await import("../prompts/store.js");
    const promptStore = new PromptStore();
    const existing = await promptStore.getById(id);
    if (!existing) throw new HttpError(404, `No prompt '${id}'.`);
    const ownerId = (existing.owner_user as string | null) ?? (existing.actor_id as string | null) ?? undefined;
    await guard(deps, actor, "prompts", "delete", { ownerId: ownerId ?? undefined });
    const ok = await promptStore.deleteById(id);
    return send(req, res, ok ? 200 : 404, { deleted: ok, id });
  }

  // ── users (RBAC-managed) ────────────────────────────────────────────────────
  if (pathname === "/api/users" && method === "GET") {
    await guard(deps, actor, "users", "read");
    const { listUsers } = await import("../auth/users.js");
    return send(req, res, 200, await listUsers());
  }
  if (pathname === "/api/users" && method === "POST") {
    await guard(deps, actor, "users", "create");
    const { createUser } = await import("../auth/users.js");
    const body = await readJson(req);
    const created = await createUser({
      username: String(body.username ?? ""),
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      role: body.role ? String(body.role) : undefined,
    });
    return send(req, res, 201, created);
  }
  const ur = /^\/api\/users\/([^/]+)\/role$/.exec(pathname);
  if (ur && method === "PATCH") {
    await guard(deps, actor, "users", "set_role");
    const { setUserRole } = await import("../auth/users.js");
    const body = await readJson(req);
    const updated = await setUserRole(decodeURIComponent(ur[1]), String(body.role ?? ""));
    return send(req, res, 200, updated);
  }

  throw new HttpError(404, `No route for ${method} ${pathname}.`);
}

const DEFAULT_DEPS: ApiDeps = {
  resolveSession,
  createSession,
  revokeSession,
  verifyCredentials: verifyWebCredentials,
  registerUser: async (seed) => {
    const { registerUser } = await import("../auth/users.js");
    return registerUser(seed, { source: "web" });
  },
  applyConfigUpdates: async (updates) => {
    const { applyConfigUpdates } = await import("../config/store.js");
    return applyConfigUpdates(updates);
  },
  audit: recordAudit,
  upsertMemory: upsertMemoryDoc,
  setupStatus: async () => {
    const { getSetupStatus } = await import("./setup.js");
    return getSetupStatus();
  },
  createSetupRoot: async (seed) => {
    const { createSetupRoot } = await import("../auth/users.js");
    return createSetupRoot(seed, { source: "web" });
  },
  probeMongo: async (uri, db) => {
    const { probeMongo } = await import("./setup.js");
    return probeMongo(uri, db);
  },
  isLoopback,
  // `aitl ui` overrides this with the exit-75 shutdown; standalone embedders get a warning.
  requestRestart: () => {
    console.warn("[api] restart requested but no supervisor is wired (start via `aitl ui`)");
  },
  runInitDb: async () => {
    const { initDb } = await import("../db/init.js");
    return initDb();
  },
};

/** Build the memory-admin API server (not yet listening). Deps are injectable for tests. */
export function createApiServer(overrides: Partial<ApiDeps> = {}): Server {
  const deps: ApiDeps = { ...DEFAULT_DEPS, ...overrides };
  return createServer((req, res) => {
    // Production SPA (`aitl ui --static`): non-/api GETs stream the built web app
    // from the same port, so one origin serves both the UI and the API.
    if (deps.staticDir && (req.method === "GET" || req.method === "HEAD")) {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!pathname.startsWith("/api")) {
        void (async () => {
          const { resolveStaticFile } = await import("./staticFiles.js");
          const hit = resolveStaticFile(deps.staticDir as string, pathname);
          if (!hit) return send(req, res, 404, { error: "SPA build not found (run `vite build` in web/)." });
          res.writeHead(200, {
            "content-type": hit.type,
            "cache-control": hit.immutable ? "public, max-age=31536000, immutable" : "no-cache",
          });
          if (req.method === "HEAD") return res.end();
          const { createReadStream } = await import("node:fs");
          createReadStream(hit.file).pipe(res);
        })().catch(() => send(req, res, 500, { error: "static serve failed" }));
        return;
      }
    }
    handle(req, res, deps).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const body =
        err instanceof HttpError && err.body
          ? err.body
          : { error: err instanceof Error ? err.message : String(err) };
      send(req, res, status, body);
    });
  });
}
