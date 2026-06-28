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
 *   GET    /api/config                      effective profile (secrets masked)
 *   GET    /api/projects
 *   GET    /api/memory?project=&category=&type=&limit=
 *   GET    /api/memory/search?project=&q=&limit=
 *   GET    /api/memory/:slug?project=
 *   POST   /api/memory                       {project,slug,body,description,type,tags}
 *   PUT    /api/memory/:slug                 (same body; upsert)
 *   DELETE /api/memory/:slug?project=
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { Server } from "node:http";
import { MEMORY_TYPES, type MemoryType, makeMemoryDoc } from "../memory/schemas.js";
import { recordAudit } from "../auth/audit.js";
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

/**
 * Resolve the calling actor. The web client never holds Mongo credentials; it
 * presents a bearer token mapped to an actor via the `AITL_WEB_TOKENS` env
 * (JSON: { "<token>": { "id": "...", "role": "..." } }). With no/unknown token
 * the caller is an anonymous `user` (least privilege), so privileged routes 403.
 */
function resolveActor(req: IncomingMessage): Actor {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token) {
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
  return { id: "web:anonymous", role: "user", source: "web" };
}

/** RBAC guard + audit. Throws HttpError(403) on denial; records both outcomes. */
async function guard(
  actor: Actor,
  resource: Resource,
  action: Action,
  ctx: AccessContext = {},
): Promise<void> {
  const decision = can(actor, resource, action, ctx);
  await recordAudit({
    actor_id: actor.id,
    actor_role: actor.role,
    source: "web",
    action: `${resource}.${action}`,
    resource,
    resource_owner: ctx.ownerId,
    ok: decision.allow,
    reason: decision.reason,
  });
  if (!decision.allow) throw new HttpError(403, decision.reason);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...jsonHeaders,
    // Permissive CORS so the Vite dev server (separate origin) can call the API.
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

/** Reuse the MCP `write_memory` contract: classify + embed + upsert one doc. */
async function upsertMemoryDoc(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { embedOne } = await import("../ingest/embedder.js");
  const { extractLinks } = await import("../ingest/markdown.js");
  const { Classifier } = await import("../memory/classifier.js");
  const { MemoryStore } = await import("../memory/store.js");

  const project = String(body.project ?? "");
  const slug = String(body.slug ?? "");
  if (!project || !slug) throw new HttpError(400, "`project` and `slug` are required.");

  const rawType = String(body.type ?? "project");
  const type: MemoryType =
    (MEMORY_TYPES as readonly string[]).includes(rawType) && rawType !== "synthesis"
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
  await new MemoryStore().upsertMemory(doc);
  return { slug: doc.slug, project: doc.project, category: doc.category, type: doc.type };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname, searchParams } = url;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return send(res, 204, {});
  if (pathname === "/api/health") return send(res, 200, { ok: true });

  const actor = resolveActor(req);
  if (pathname === "/api/auth/me" && method === "GET") {
    return send(res, 200, { id: actor.id, role: actor.role, source: actor.source });
  }

  if (pathname === "/api/config" && method === "GET") {
    // Secrets are masked by resolveProfile; only root may read effective config.
    await guard(actor, "config_secrets", "read");
    const { resolveProfile } = await import("../config/store.js");
    return send(res, 200, resolveProfile());
  }

  const { MemoryStore } = await import("../memory/store.js");
  const store = new MemoryStore();

  if (pathname === "/api/projects" && method === "GET") {
    return send(res, 200, await store.listProjects());
  }

  // ── graph (durable-state projection) ──────────────────────────────────────
  if (pathname === "/api/graph" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const scope = (searchParams.get("scope") ?? "all") as "all" | "symbols" | "memory";
    const { graphify, MongoGraphSource } = await import("../graph/index.js");
    const graphs = await graphify(new MongoGraphSource(store.db), { project, scope });
    return send(res, 200, graphs[project] ?? { nodes: [], edges: [] });
  }

  if (pathname === "/api/memory/search" && method === "GET") {
    const project = searchParams.get("project") ?? undefined;
    const q = searchParams.get("q") ?? "";
    const limit = Number(searchParams.get("limit") ?? "20");
    const { embedOne } = await import("../ingest/embedder.js");
    let hits: unknown[];
    try {
      hits = await store.vectorSearch("memory", await embedOne(q), { project, limit });
    } catch {
      hits = await store.textSearch("memory", q, { project, limit });
    }
    return send(res, 200, hits);
  }

  if (pathname === "/api/memory" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    return send(res, 200, await store.listMemory(project, {
      category: searchParams.get("category") ?? undefined,
      type: searchParams.get("type") ?? undefined,
      limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined,
    }));
  }

  if (pathname === "/api/memory" && (method === "POST" || method === "PUT")) {
    await guard(actor, "memory", method === "POST" ? "create" : "update");
    return send(res, 200, await upsertMemoryDoc(await readJson(req)));
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
      return send(res, 200, doc);
    }
    if (method === "PUT") {
      await guard(actor, "memory", "update");
      return send(res, 200, await upsertMemoryDoc({ ...(await readJson(req)), slug }));
    }
    if (method === "DELETE") {
      await guard(actor, "memory", "delete");
      const project = searchParams.get("project");
      if (!project) throw new HttpError(400, "`project` query param is required.");
      const ok = await store.deleteMemory(project, slug);
      return send(res, ok ? 200 : 404, { deleted: ok, slug, project });
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
    return send(res, 200, rows);
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
    return send(res, 200, doc);
  }

  // ── prompt history ────────────────────────────────────────────────────────
  if (pathname === "/api/prompts" && method === "GET") {
    const project = searchParams.get("project");
    if (!project) throw new HttpError(400, "`project` query param is required.");
    const { PromptStore } = await import("../prompts/store.js");
    const rows = await new PromptStore().list(project, {
      limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : 200,
    });
    return send(res, 200, rows);
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
    await guard(actor, "prompts", "delete", { ownerId: ownerId ?? undefined });
    const ok = await promptStore.deleteById(id);
    return send(res, ok ? 200 : 404, { deleted: ok, id });
  }

  // ── users (RBAC-managed) ────────────────────────────────────────────────────
  if (pathname === "/api/users" && method === "GET") {
    await guard(actor, "users", "read");
    const { listUsers } = await import("../auth/users.js");
    return send(res, 200, await listUsers(store.db));
  }
  if (pathname === "/api/users" && method === "POST") {
    await guard(actor, "users", "create");
    const { createUser } = await import("../auth/users.js");
    const body = await readJson(req);
    const created = await createUser(
      {
        username: String(body.username ?? ""),
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
        role: body.role ? String(body.role) : undefined,
      },
      store.db,
    );
    return send(res, 201, created);
  }
  const ur = /^\/api\/users\/([^/]+)\/role$/.exec(pathname);
  if (ur && method === "PATCH") {
    await guard(actor, "users", "set_role");
    const { setUserRole } = await import("../auth/users.js");
    const body = await readJson(req);
    const updated = await setUserRole(decodeURIComponent(ur[1]), String(body.role ?? ""), store.db);
    return send(res, 200, updated);
  }

  throw new HttpError(404, `No route for ${method} ${pathname}.`);
}

/** Build the memory-admin API server (not yet listening). */
export function createApiServer(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}
