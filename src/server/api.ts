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
 *   POST   /api/auth/logout                  (Bearer) revoke session → 204
 *   GET    /api/auth/me                      resolved actor identity
 *   GET    /api/config                      effective profile (secrets masked)
 *   GET    /api/projects
 *   GET    /api/memory?project=&category=&type=&limit=
 *   GET    /api/memory/search?project=&q=&limit=
 *   GET    /api/memory/:slug?project=
 *   POST   /api/memory                       {project,slug,body,description,type,tags}
 *   PUT    /api/memory/:slug                 (same body; upsert)
 *   DELETE /api/memory/:slug?project=
 *   GET    /api/runs?project=&limit=         run telemetry (tokens, cost, iters, status)
 *   GET    /api/runs/:id                     one run + event counts + supervision minutes
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { Server } from "node:http";
import { MEMORY_TYPES, RESERVED_MEMORY_TYPES, type MemoryType } from "../memory/schemas.js";
import { makeMemoryDoc } from "../models/memory.model.js";
import { recordAudit } from "../auth/audit.js";
import { createSession, resolveSession, revokeSession } from "../auth/sessions.js";
import type { VerifyUserResult } from "../auth/users.js";
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
  audit: typeof recordAudit;
  upsertMemory: (body: Record<string, unknown>, actor?: Actor) => Promise<Record<string, unknown>>;
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
  const allowed = (process.env.AITL_WEB_ORIGINS ?? DEFAULT_WEB_ORIGINS)
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
  const doc = makeMemoryDoc({
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

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, "bearer token required", { error: "login_required", hint: "POST /api/auth/login" });
    await deps.revokeSession(token);
    return send(req, res, 204, {});
  }

  const actor = await resolveActor(req, deps);
  if (pathname === "/api/auth/me" && method === "GET") {
    return send(req, res, 200, { id: actor.id, role: actor.role, source: actor.source });
  }

  if (pathname === "/api/config" && method === "GET") {
    // Secrets are masked by resolveProfile; only root may read effective config.
    await guard(deps, actor, "config_secrets", "read");
    const { resolveProfile } = await import("../config/store.js");
    return send(req, res, 200, resolveProfile());
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
  audit: recordAudit,
  upsertMemory: upsertMemoryDoc,
};

/** Build the memory-admin API server (not yet listening). Deps are injectable for tests. */
export function createApiServer(overrides: Partial<ApiDeps> = {}): Server {
  const deps: ApiDeps = { ...DEFAULT_DEPS, ...overrides };
  return createServer((req, res) => {
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
