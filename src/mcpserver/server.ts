/**
 * MCP server exposing AITL-Harness durable artifacts as MCP tools.
 *
 * Tool surface (memory-backend role): search_memory · write_memory · ingest_path ·
 * get_repomap · list_decisions · record_decision · graphify.
 *
 * Every tool is project-scoped. Returns are plain JSON-able values (ObjectId / Date
 * are sanitized) so any MCP client can consume them. Mirrors aitl/mcpserver/server.py.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { settings } from "../config.js";
import { recordAudit } from "../auth/audit.js";
import { type Action, type Actor, type Resource, type Role, can, isRole } from "../auth/rbac.js";
import { bootstrapBaseUser } from "../auth/users.js";
import { connectWithFallback, getDb } from "../db/client.js";
import { embedOne } from "../ingest/embedder.js";
import { extractLinks, parseMarkdownDir } from "../ingest/markdown.js";
import { Classifier } from "../memory/classifier.js";
import { MEMORY_TYPES, type MemoryType, makeMemoryDoc } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";
import { ADRStore } from "../decisions/adr.js";
import { RepoMap } from "../repomap/store.js";
import { DefinitionStore } from "../projectctx/store.js";
import { AGENTS_COLLECTION, SKILLS_COLLECTION, type DefinitionKind } from "../projectctx/schemas.js";
import { MongoGraphSource, type Scope, graphToDot, graphify } from "../graph/index.js";
import { currentBranch } from "../util/git.js";

/** Recursively strip Mongo `_id`/`embedding` and stringify ObjectId/Date. */
function jsonable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonable);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if (value.constructor?.name === "ObjectId") return String(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "_id" || k === "embedding") continue;
      out[k] = jsonable(v);
    }
    return out;
  }
  return value;
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const logFile = process.env.AITL_MCP_LOG_FILE?.trim() || undefined;
const logChars = Number.parseInt(process.env.AITL_MCP_LOG_RESULT_CHARS ?? "4000", 10);
const contextChars = Number.parseInt(process.env.AITL_MCP_CONTEXT_CHARS ?? "100000", 10);

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.includes("apikey") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("authorization")
  );
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? "[redacted]" : redact(val);
    }
    return out;
  }
  return value;
}

function preview(value: unknown): string {
  let raw: string;
  try {
    const safe = redact(jsonable(value));
    raw = typeof safe === "string" ? safe : JSON.stringify(safe);
  } catch {
    raw = String(value);
  }

  const max = Number.isFinite(logChars) && logChars > 0 ? logChars : 4000;
  return raw.length > max ? `${raw.slice(0, max)}... [truncated ${raw.length - max} chars]` : raw;
}

function storagePreview(value: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(redact(jsonable(value)));
  } catch {
    raw = String(value);
  }
  const max = Number.isFinite(contextChars) && contextChars > 0 ? contextChars : 100000;
  return raw.length > max ? `${raw.slice(0, max)}... [truncated ${raw.length - max} chars]` : raw;
}

function storageValue(value: unknown): unknown {
  try {
    const safe = redact(jsonable(value));
    const raw = JSON.stringify(safe);
    const max = Number.isFinite(contextChars) && contextChars > 0 ? contextChars : 100000;
    if (raw.length > max) return { truncated: true, preview: `${raw.slice(0, max)}... [truncated ${raw.length - max} chars]` };
    return safe;
  } catch {
    return String(value);
  }
}

function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack?.split("\n").slice(0, 4).join("\n") };
  return { message: String(err) };
}

function maskUri(uri: string | undefined): string | undefined {
  return uri?.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:<redacted>@");
}

function logEvent(event: string, data: Record<string, unknown> = {}): void {
  const line = `[aitl-js:mcp] ${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data })}\n`;
  process.stderr.write(line);

  if (!logFile) return;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line, "utf8");
  } catch (err) {
    process.stderr.write(
      `[aitl-js:mcp] ${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event: "log:error", error: errorInfo(err) })}\n`,
    );
  }
}

function projectFromArgs(args: Record<string, unknown>): string {
  return typeof args.project === "string" && args.project.trim() ? args.project : process.env.AITL_MCP_PROJECT || "mcp";
}

let mcpStorageReady: Promise<void> | null = null;

async function ensureCollection(name: string): Promise<void> {
  const db = getDb();
  const exists = await db.listCollections({ name }).hasNext();
  if (!exists) {
    try {
      await db.createCollection(name);
    } catch (err) {
      if (!String(err).includes("already exists")) throw err;
    }
  }
}

async function ensureMcpStorage(): Promise<void> {
  if (mcpStorageReady === null) {
    mcpStorageReady = (async () => {
      const db = getDb();
      for (const name of ["prompts", "mcp_context", "mcp_tool_calls"]) {
        await ensureCollection(name);
      }

      await db.collection("prompts").createIndex({ project: 1, created_at: -1 });
      await db.collection("prompts").createIndex({ project: 1, source: 1, created_at: -1 });
      await db.collection("prompts").createIndex({ project: 1, tags: 1 });
      await db.collection("prompts").createIndex({ title: "text", prompt: "text" });

      await db.collection("mcp_context").createIndex({ project: 1, created_at: -1 });
      await db.collection("mcp_context").createIndex({ project: 1, source: 1, created_at: -1 });
      await db.collection("mcp_context").createIndex({ project: 1, run_id: 1 });
      await db.collection("mcp_context").createIndex({ project: 1, tags: 1 });
      await db.collection("mcp_context").createIndex({ context_id: 1 }, { unique: true });
      await db.collection("mcp_context").createIndex({ title: "text", content_text: "text" });

      await db.collection("mcp_tool_calls").createIndex({ project: 1, ts: -1 });
      await db.collection("mcp_tool_calls").createIndex({ tool: 1, ts: -1 });
      await db.collection("mcp_tool_calls").createIndex({ ok: 1, ts: -1 });
      await db.collection("mcp_tool_calls").createIndex({
        tool: "text",
        args_preview: "text",
        result_preview: "text",
        error_message: "text",
      });
    })().catch((err) => {
      mcpStorageReady = null;
      throw err;
    });
  }
  await mcpStorageReady;
}

let projectCtxStorageReady: Promise<void> | null = null;

async function ensureProjectCtxStorage(): Promise<void> {
  if (projectCtxStorageReady === null) {
    projectCtxStorageReady = (async () => {
      const db = getDb();
      for (const name of [AGENTS_COLLECTION, SKILLS_COLLECTION]) {
        await ensureCollection(name);
        await db.collection(name).createIndex({ project: 1, name: 1 }, { unique: true });
        await db.collection(name).createIndex({ project: 1, updated_at: -1 });
        await db.collection(name).createIndex({ project: 1, tags: 1 });
        await db.collection(name).createIndex({ name: "text", description: "text", content: "text" });
      }
    })().catch((err) => {
      projectCtxStorageReady = null;
      throw err;
    });
  }
  await projectCtxStorageReady;
}

async function persistMcpToolCall(doc: Record<string, unknown>): Promise<void> {
  try {
    await ensureMcpStorage();
    await getDb().collection("mcp_tool_calls").insertOne(doc);
  } catch (err) {
    logEvent("mcp-context:error", { reason: "persist_tool_call_failed", error: errorInfo(err) });
  }
}

/**
 * Tools that mutate durable state, mapped to the RBAC resource/action they need.
 * Read-only tools are absent → never RBAC-restricted.
 */
const TOOL_RBAC: Record<string, { resource: Resource; action: Action }> = {
  write_memory: { resource: "memory", action: "create" },
  ingest_path: { resource: "memory", action: "create" },
  graphify: { resource: "memory", action: "update" },
  record_decision: { resource: "decisions", action: "create" },
  record_prompt: { resource: "prompts", action: "create" },
  write_software: { resource: "softwares", action: "create" },
  delete_software: { resource: "softwares", action: "delete" },
  write_repo: { resource: "repos", action: "create" },
  delete_repo: { resource: "repos", action: "delete" },
  index_repo: { resource: "memory", action: "create" },
  build_definition: { resource: "agents_skills", action: "create" },
  sync_branches: { resource: "branches", action: "create" },
  delete_branch: { resource: "branches", action: "delete" },
  write_role: { resource: "agents_skills", action: "create" },
  seed_roles: { resource: "agents_skills", action: "create" },
};

/**
 * Service identity for the MCP surface. Per RBAC-REGISTRO, the MCP server acts as
 * an authorized `agent` by default; override with AITL_MCP_ACTOR_ROLE / _ID (e.g.
 * an `auditor` token that may only read).
 */
function mcpActor(): Actor {
  const role = process.env.AITL_MCP_ACTOR_ROLE;
  return {
    id: process.env.AITL_MCP_ACTOR_ID ?? "agent:aitl-server",
    role: isRole(role) ? (role as Role) : "agent",
    source: "mcp",
  };
}

/** RBAC guard for a sensitive tool. Audits the decision; throws on denial. */
async function guardTool(tool: string, args: Record<string, unknown>): Promise<void> {
  const need = TOOL_RBAC[tool];
  if (!need) return;
  const actor = mcpActor();
  const decision = can(actor, need.resource, need.action, { delegated: true });
  await recordAudit({
    actor_id: actor.id,
    actor_role: actor.role,
    source: "mcp",
    action: `${need.resource}.${need.action}`,
    resource: `${need.resource}:${tool}`,
    ok: decision.allow,
    reason: decision.reason,
  });
  if (!decision.allow) throw new Error(`RBAC denied: ${decision.reason} (tool=${tool})`);
}

async function runLogged<T>(tool: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  logEvent("tool:start", { tool, args: preview(args) });
  try {
    await guardTool(tool, args);
    const result = await fn();
    const ms = Date.now() - started;
    logEvent("tool:end", { tool, ms, result: preview(result) });
    await persistMcpToolCall({
      project: projectFromArgs(args),
      tool,
      ok: true,
      args: storageValue(args),
      args_preview: storagePreview(args),
      result: storageValue(result),
      result_preview: storagePreview(result),
      ms,
      ts: new Date(),
    });
    return result;
  } catch (err) {
    const ms = Date.now() - started;
    const error = errorInfo(err);
    logEvent("tool:error", { tool, ms, error });
    await persistMcpToolCall({
      project: projectFromArgs(args),
      tool,
      ok: false,
      args: storageValue(args),
      args_preview: storagePreview(args),
      error,
      error_message: typeof error.message === "string" ? error.message : JSON.stringify(error),
      ms,
      ts: new Date(),
    });
    throw err;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contextText(title: string, summary: string, messages: unknown[], context: Record<string, unknown>): string {
  const parts = [title, summary];
  for (const msg of messages) {
    if (msg && typeof msg === "object") {
      const role = "role" in msg ? String((msg as Record<string, unknown>).role ?? "") : "";
      const content = "content" in msg ? String((msg as Record<string, unknown>).content ?? "") : JSON.stringify(msg);
      parts.push(`${role}: ${content}`);
    } else {
      parts.push(String(msg));
    }
  }
  if (Object.keys(context).length) parts.push(JSON.stringify(context));
  return parts.filter(Boolean).join("\n");
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "aitl-harness", version: "0.1.0" });

  // ── memory ───────────────────────────────────────────────────────────────
  server.tool(
    "search_memory",
    "Semantic search over durable state for a project (collection: memory|messages|decisions). Atlas $vectorSearch with $text fallback.",
    { query: z.string(), project: z.string(), collection: z.string().default("memory"), limit: z.number().int().default(10) },
    async ({ query, project, collection, limit }) => {
      return runLogged("search_memory", { query, project, collection, limit }, async () => {
        const store = new MemoryStore();
        let hits: unknown[];
        try {
          hits = await store.vectorSearch(collection, await embedOne(query), { project, limit });
        } catch {
          hits = await store.textSearch(collection, query, { project, limit });
        }
        return text(hits.map(jsonable));
      });
    },
  );

  server.tool(
    "write_memory",
    "Persist ONE structured memory doc (classified + embedded), keyed by (project, slug). `type`: user|feedback|project|reference.",
    {
      project: z.string(),
      slug: z.string(),
      body: z.string(),
      description: z.string().default(""),
      type: z.string().default("project"),
      tags: z.array(z.string()).optional(),
      repo: z.string().optional(),
    },
    async ({ project, slug, body, description, type, tags, repo }) => {
      return runLogged("write_memory", { project, slug, body, description, type, tags, repo }, async () => {
        const t: MemoryType = (MEMORY_TYPES as readonly string[]).includes(type) && type !== "synthesis"
          ? (type as MemoryType)
          : "project";
        const doc = makeMemoryDoc({ project, slug, repo: repo ?? null, type: t, description, body, links: extractLinks(body), tags: tags ?? [] });
        await new Classifier().classifyMemory(doc);
        doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
        const a = mcpActor();
        await new MemoryStore().upsertMemory(doc, { actor: { id: a.id, role: a.role }, branch: currentBranch() });
        return text({ slug: doc.slug, category: doc.category, type: doc.type, version: doc.version });
      });
    },
  );

  server.tool(
    "ingest_path",
    "Bulk-ingest a directory of markdown memory files into a project. Optional `repo` sub-scope.",
    { path: z.string(), project: z.string(), repo: z.string().optional() },
    async ({ path, project, repo }) => {
      return runLogged("ingest_path", { path, project, repo }, async () => {
        const store = new MemoryStore();
        const clf = new Classifier();
        const a = mcpActor();
        const branch = currentBranch();
        const docs = await parseMarkdownDir(path, project);
        for (const doc of docs) {
          if (repo) doc.repo = repo;
          await clf.classifyMemory(doc);
          doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
          await store.upsertMemory(doc, { actor: { id: a.id, role: a.role }, branch });
        }
        return text({ ingested: docs.length, project, repo: repo ?? null });
      });
    },
  );

  // ── repo map ───────────────────────────────────────────────────────────────
  server.tool(
    "save_mcp_context",
    "Persist a complete MCP context snapshot supplied by the client: messages, summary, metadata, tags and arbitrary context.",
    {
      project: z.string(),
      messages: z.array(z.record(z.unknown())).default([]),
      title: z.string().default(""),
      summary: z.string().default(""),
      source: z.string().default("mcp"),
      model: z.string().optional(),
      run_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
      context: z.record(z.unknown()).optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async ({ project, messages, title, summary, source, model, run_id, tags, context, metadata }) => {
      return runLogged("save_mcp_context", { project, title, summary, source, model, run_id, tags, messages, context, metadata }, async () => {
        await ensureMcpStorage();
        const contextId = randomUUID();
        const contextBody = context ?? {};
        const doc = {
          context_id: contextId,
          project,
          title,
          summary,
          source,
          model: model ?? null,
          run_id: run_id ?? null,
          tags: tags ?? [],
          messages: storageValue(messages),
          context: storageValue(contextBody),
          metadata: storageValue(metadata ?? {}),
          content_text: contextText(title, summary, messages, contextBody),
          created_at: new Date(),
          updated_at: new Date(),
        };
        const result = await getDb().collection("mcp_context").insertOne(doc);
        return text({
          id: String(result.insertedId),
          context_id: contextId,
          project,
          title,
          source,
          run_id: doc.run_id,
          messages: messages.length,
          tags: doc.tags,
          created_at: doc.created_at,
        });
      });
    },
  );

  server.tool(
    "list_mcp_context",
    "List saved MCP context snapshots for a project, newest first.",
    {
      project: z.string(),
      limit: z.number().int().min(1).max(200).default(50),
      source: z.string().optional(),
      tag: z.string().optional(),
      run_id: z.string().optional(),
    },
    async ({ project, limit, source, tag, run_id }) => {
      return runLogged("list_mcp_context", { project, limit, source, tag, run_id }, async () => {
        await ensureMcpStorage();
        const query: Record<string, unknown> = { project };
        if (source) query.source = source;
        if (tag) query.tags = tag;
        if (run_id) query.run_id = run_id;
        const rows = await getDb()
          .collection("mcp_context")
          .find(query, { projection: { content_text: 0 } })
          .sort({ created_at: -1 })
          .limit(limit)
          .toArray();
        return text(rows.map(jsonable));
      });
    },
  );

  server.tool(
    "search_mcp_context",
    "Search saved MCP context snapshots by text for a project.",
    { project: z.string(), query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    async ({ project, query, limit }) => {
      return runLogged("search_mcp_context", { project, query, limit }, async () => {
        await ensureMcpStorage();
        const coll = getDb().collection("mcp_context");
        let rows: unknown[];
        try {
          rows = await coll
            .find({ project, $text: { $search: query } }, { projection: { score: { $meta: "textScore" }, content_text: 0 } })
            .sort({ score: { $meta: "textScore" }, created_at: -1 })
            .limit(limit)
            .toArray();
        } catch {
          const rx = new RegExp(escapeRegex(query), "i");
          rows = await coll
            .find({ project, $or: [{ title: rx }, { summary: rx }, { content_text: rx }] }, { projection: { content_text: 0 } })
            .sort({ created_at: -1 })
            .limit(limit)
            .toArray();
        }
        return text(rows.map(jsonable));
      });
    },
  );

  server.tool(
    "record_prompt",
    "Persist a prompt in durable prompt history for a project.",
    {
      project: z.string(),
      prompt: z.string(),
      title: z.string().default(""),
      source: z.string().default("mcp"),
      model: z.string().optional(),
      run_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async ({ project, prompt, title, source, model, run_id, tags, metadata }) => {
      return runLogged("record_prompt", { project, prompt, title, source, model, run_id, tags, metadata }, async () => {
        await ensureMcpStorage();
        const doc = {
          project,
          prompt,
          title,
          source,
          model: model ?? null,
          run_id: run_id ?? null,
          tags: tags ?? [],
          metadata: metadata ?? {},
          created_at: new Date(),
        };
        const result = await getDb().collection("prompts").insertOne(doc);
        return text({ id: String(result.insertedId), ...(jsonable(doc) as Record<string, unknown>) });
      });
    },
  );

  server.tool(
    "list_prompts",
    "List recent prompt history for a project, newest first.",
    {
      project: z.string(),
      limit: z.number().int().min(1).max(200).default(50),
      source: z.string().optional(),
      tag: z.string().optional(),
    },
    async ({ project, limit, source, tag }) => {
      return runLogged("list_prompts", { project, limit, source, tag }, async () => {
        await ensureMcpStorage();
        const query: Record<string, unknown> = { project };
        if (source) query.source = source;
        if (tag) query.tags = tag;
        const rows = await getDb()
          .collection("prompts")
          .find(query)
          .sort({ created_at: -1 })
          .limit(limit)
          .toArray();
        return text(rows.map(jsonable));
      });
    },
  );

  server.tool(
    "search_prompts",
    "Search durable prompt history for a project. Uses Mongo text search with regex fallback.",
    { project: z.string(), query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    async ({ project, query, limit }) => {
      return runLogged("search_prompts", { project, query, limit }, async () => {
        await ensureMcpStorage();
        const coll = getDb().collection("prompts");
        let rows: unknown[];
        try {
          rows = await coll
            .find({ project, $text: { $search: query } }, { projection: { score: { $meta: "textScore" } } })
            .sort({ score: { $meta: "textScore" }, created_at: -1 })
            .limit(limit)
            .toArray();
        } catch {
          const rx = new RegExp(escapeRegex(query), "i");
          rows = await coll
            .find({ project, $or: [{ title: rx }, { prompt: rx }] })
            .sort({ created_at: -1 })
            .limit(limit)
            .toArray();
        }
        return text(rows.map(jsonable));
      });
    },
  );

  server.tool(
    "get_repomap",
    "Return the tree-sitter + PageRank repo map for a project (optional `repo` sub-scope). If `root` is given it is (re)built first; otherwise the cached map is rendered.",
    { project: z.string(), root: z.string().optional(), maxTokens: z.number().int().default(1024), repo: z.string().optional() },
    async ({ project, root, maxTokens, repo }) => {
      return runLogged("get_repomap", { project, root, maxTokens, repo }, async () => {
        const rm = new RepoMap();
        if (root) await rm.build(root, project, repo ?? null);
        return text(await rm.render(project, repo ? { maxTokens, repo } : { maxTokens }));
      });
    },
  );

  // ── decisions / ADRs ────────────────────────────────────────────────────────
  server.tool(
    "list_decisions",
    "List versioned Architecture Decision Records for a project.",
    { project: z.string(), limit: z.number().int().default(50) },
    async ({ project, limit }) => {
      return runLogged("list_decisions", { project, limit }, async () => {
        const rows = await getDb().collection("decisions").find({ project }).sort({ id: 1 }).limit(limit).toArray();
        return text(rows.map(jsonable));
      });
    },
  );

  server.tool(
    "record_decision",
    'Record a versioned ADR (embedded for $vectorSearch). `id` e.g. "0007".',
    {
      project: z.string(),
      id: z.string(),
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      consequences: z.string().default(""),
      status: z.enum(["proposed", "accepted", "superseded"]).default("accepted"),
    },
    async ({ project, id, title, context, decision, consequences, status }) => {
      return runLogged("record_decision", { project, id, title, context, decision, consequences, status }, async () => {
        const { makeADR } = await import("../memory/schemas.js");
        const adr = makeADR({ project, id, title, context, decision, consequences, status });
        const a = mcpActor();
        await new ADRStore().upsert(adr, { actor: { id: a.id, role: a.role }, branch: currentBranch() });
        return text({ id: adr.id, title: adr.title, status: adr.status, version: adr.version });
      });
    },
  );

  // ── revision history (ADR-0027): read-only, ungated like other reads ─────────
  const stripEmbedding = (d: Record<string, unknown> | null) => {
    if (!d) return d;
    const { embedding, _id, ...rest } = d;
    return rest;
  };

  server.tool(
    "list_decision_versions",
    "List the revision history of an ADR (current live version + archived snapshots).",
    { project: z.string(), id: z.string() },
    async ({ project, id }) => {
      const db = getDb();
      const live = await db.collection("decisions").findOne({ project, id }, { projection: { embedding: 0 } });
      const history = await db
        .collection("decisions_history")
        .find({ project, ref: id }, { projection: { "snapshot.embedding": 0 } })
        .sort({ version: -1 })
        .toArray();
      return text({
        ref: id,
        current: typeof live?.version === "number" ? live.version : live ? 1 : null,
        title: live?.title ?? null,
        status: live?.status ?? null,
        branch: live?.branch ?? null,
        history: history.map((h) => jsonable({ version: h.version, archived_at: h.archived_at, actor_id: h.actor_id, actor_role: h.actor_role, branch: h.branch ?? null, title: (h.snapshot as Record<string, unknown>)?.title, status: (h.snapshot as Record<string, unknown>)?.status })),
      });
    },
  );

  server.tool(
    "get_decision_version",
    "Fetch a specific ADR version (live if it is the current version, else from history).",
    { project: z.string(), id: z.string(), version: z.number().int() },
    async ({ project, id, version }) => {
      const db = getDb();
      const live = await db.collection("decisions").findOne({ project, id }, { projection: { embedding: 0 } });
      const liveVersion = typeof live?.version === "number" ? live.version : 1;
      if (live && liveVersion === version) return text(jsonable(stripEmbedding(live as Record<string, unknown>)));
      const hist = await db.collection("decisions_history").findOne({ project, ref: id, version });
      if (!hist) return text({ error: `no version ${version} for ADR ${id}` });
      return text(jsonable((hist as Record<string, unknown>).snapshot));
    },
  );

  server.tool(
    "list_memory_versions",
    "List the revision history of a memory doc (current live version + archived snapshots).",
    { project: z.string(), slug: z.string() },
    async ({ project, slug }) => {
      const db = getDb();
      const live = await db.collection("memory").findOne({ project, slug }, { projection: { embedding: 0 } });
      const history = await db
        .collection("memory_history")
        .find({ project, ref: slug }, { projection: { "snapshot.embedding": 0 } })
        .sort({ version: -1 })
        .toArray();
      return text({
        ref: slug,
        current: typeof live?.version === "number" ? live.version : live ? 1 : null,
        description: live?.description ?? null,
        branch: live?.branch ?? null,
        history: history.map((h) => jsonable({ version: h.version, archived_at: h.archived_at, actor_id: h.actor_id, actor_role: h.actor_role, branch: h.branch ?? null, description: (h.snapshot as Record<string, unknown>)?.description })),
      });
    },
  );

  server.tool(
    "get_memory_version",
    "Fetch a specific memory doc version (live if it is the current version, else from history).",
    { project: z.string(), slug: z.string(), version: z.number().int() },
    async ({ project, slug, version }) => {
      const db = getDb();
      const live = await db.collection("memory").findOne({ project, slug }, { projection: { embedding: 0 } });
      const liveVersion = typeof live?.version === "number" ? live.version : 1;
      if (live && liveVersion === version) return text(jsonable(stripEmbedding(live as Record<string, unknown>)));
      const hist = await db.collection("memory_history").findOne({ project, ref: slug, version });
      if (!hist) return text({ error: `no version ${version} for memory ${slug}` });
      return text(jsonable((hist as Record<string, unknown>).snapshot));
    },
  );

  // ── project context: agents & skills ────────────────────────────────────────
  // Reusable, project-scoped definitions the MCP serves on every repo call so a
  // client can recover project context. Same CRUD/search surface for both kinds.
  const registerDefinitionTools = (kind: DefinitionKind) => {
    const noun = kind; // "agent" | "skill"
    const plural = `${kind}s`;
    const store = () => new DefinitionStore(kind);

    server.tool(
      `write_${noun}`,
      `Create/update ONE project-scoped ${noun} definition, keyed by (project, name). Upsert: re-writing the same name updates it.`,
      {
        project: z.string(),
        name: z.string(),
        content: z.string(),
        description: z.string().default(""),
        source: z.string().default("mcp"),
        tags: z.array(z.string()).optional(),
      },
      async ({ project, name, content, description, source, tags }) => {
        return runLogged(`write_${noun}`, { project, name, content, description, source, tags }, async () => {
          await ensureProjectCtxStorage();
          const doc = await store().upsert({ project, name, content, description, source, tags: tags ?? [] });
          return text({ project: doc.project, name: doc.name, description: doc.description, tags: doc.tags, updated_at: doc.updated_at });
        });
      },
    );

    server.tool(
      `get_${noun}`,
      `Fetch ONE ${noun} definition by (project, name). Returns null if absent.`,
      { project: z.string(), name: z.string() },
      async ({ project, name }) => {
        return runLogged(`get_${noun}`, { project, name }, async () => {
          await ensureProjectCtxStorage();
          const doc = await store().get(project, name);
          return text(doc ? jsonable(doc) : null);
        });
      },
    );

    server.tool(
      `list_${plural}`,
      `List ${plural} for a project, newest first. Optional tag filter.`,
      { project: z.string(), limit: z.number().int().min(1).max(200).default(100), tag: z.string().optional() },
      async ({ project, limit, tag }) => {
        return runLogged(`list_${plural}`, { project, limit, tag }, async () => {
          await ensureProjectCtxStorage();
          const rows = await store().list(project, { tag, limit });
          return text(rows.map(jsonable));
        });
      },
    );

    server.tool(
      `search_${plural}`,
      `Search ${plural} for a project by text (name/description/content). Mongo $text with regex fallback.`,
      { project: z.string(), query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
      async ({ project, query, limit }) => {
        return runLogged(`search_${plural}`, { project, query, limit }, async () => {
          await ensureProjectCtxStorage();
          const rows = await store().search(project, query, limit);
          return text(rows.map(jsonable));
        });
      },
    );

    server.tool(
      `delete_${noun}`,
      `Delete ONE ${noun} definition by (project, name). Returns whether a doc was removed.`,
      { project: z.string(), name: z.string() },
      async ({ project, name }) => {
        return runLogged(`delete_${noun}`, { project, name }, async () => {
          await ensureProjectCtxStorage();
          const deleted = await store().delete(project, name);
          return text({ project, name, deleted });
        });
      },
    );
  };

  registerDefinitionTools("agent");
  registerDefinitionTools("skill");

  // ── software / repo catalog (ADR-0028: software -> projects -> repos) ─────────
  server.tool(
    "write_software",
    "Create/update ONE software (top of software->projects->repos), keyed by `name`. `projects` lists member project scopes.",
    {
      name: z.string(),
      display_name: z.string().default(""),
      description: z.string().default(""),
      projects: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ name, display_name, description, projects, tags }) => {
      return runLogged("write_software", { name, display_name, description, projects, tags }, async () => {
        const { SoftwareStore } = await import("../softwares/store.js");
        const doc = await new SoftwareStore().upsert({ name, display_name, description, projects: projects ?? [], tags: tags ?? [] });
        return text(jsonable(doc));
      });
    },
  );
  server.tool(
    "get_software",
    "Fetch ONE software by `name`. Returns null if absent.",
    { name: z.string() },
    async ({ name }) => {
      return runLogged("get_software", { name }, async () => {
        const { SoftwareStore } = await import("../softwares/store.js");
        const doc = await new SoftwareStore().get(name);
        return text(doc ? jsonable(doc) : null);
      });
    },
  );
  server.tool(
    "list_softwares",
    "List softwares, newest first. Optional tag filter.",
    { limit: z.number().int().min(1).max(200).default(100), tag: z.string().optional() },
    async ({ limit, tag }) => {
      return runLogged("list_softwares", { limit, tag }, async () => {
        const { SoftwareStore } = await import("../softwares/store.js");
        return text((await new SoftwareStore().list({ tag, limit })).map(jsonable));
      });
    },
  );
  server.tool(
    "search_softwares",
    "Search softwares by text (name/display_name/description). Mongo $text with regex fallback.",
    { query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    async ({ query, limit }) => {
      return runLogged("search_softwares", { query, limit }, async () => {
        const { SoftwareStore } = await import("../softwares/store.js");
        return text((await new SoftwareStore().search(query, limit)).map(jsonable));
      });
    },
  );
  server.tool(
    "delete_software",
    "Delete ONE software by `name`. Returns whether a doc was removed.",
    { name: z.string() },
    async ({ name }) => {
      return runLogged("delete_software", { name }, async () => {
        const { SoftwareStore } = await import("../softwares/store.js");
        return text({ name, deleted: await new SoftwareStore().delete(name) });
      });
    },
  );

  server.tool(
    "write_repo",
    "Create/update ONE repo (leaf of software->projects->repos), keyed by (project, name). `name` doubles as the data sub-scope `repo`.",
    {
      project: z.string(),
      name: z.string(),
      software: z.string().optional(),
      remote: z.string().default(""),
      branch: z.string().default(""),
      path: z.string().default(""),
      description: z.string().default(""),
      tags: z.array(z.string()).optional(),
    },
    async ({ project, name, software, remote, branch, path, description, tags }) => {
      return runLogged("write_repo", { project, name, software, remote, branch, path, description, tags }, async () => {
        const { RepoStore } = await import("../repos/store.js");
        const doc = await new RepoStore().upsert({ project, name, software: software ?? null, remote, branch, path, description, tags: tags ?? [] });
        return text(jsonable(doc));
      });
    },
  );
  server.tool(
    "get_repo",
    "Fetch ONE repo by (project, name). Returns null if absent.",
    { project: z.string(), name: z.string() },
    async ({ project, name }) => {
      return runLogged("get_repo", { project, name }, async () => {
        const { RepoStore } = await import("../repos/store.js");
        const doc = await new RepoStore().get(project, name);
        return text(doc ? jsonable(doc) : null);
      });
    },
  );
  server.tool(
    "list_repos",
    "List repos by project and/or software, newest first.",
    { project: z.string().optional(), software: z.string().optional(), limit: z.number().int().min(1).max(200).default(100), tag: z.string().optional() },
    async ({ project, software, limit, tag }) => {
      return runLogged("list_repos", { project, software, limit, tag }, async () => {
        const { RepoStore } = await import("../repos/store.js");
        return text((await new RepoStore().list({ project, software, tag, limit })).map(jsonable));
      });
    },
  );
  server.tool(
    "delete_repo",
    "Delete ONE repo by (project, name). Returns whether a doc was removed.",
    { project: z.string(), name: z.string() },
    async ({ project, name }) => {
      return runLogged("delete_repo", { project, name }, async () => {
        const { RepoStore } = await import("../repos/store.js");
        return text({ project, name, deleted: await new RepoStore().delete(project, name) });
      });
    },
  );

  // ── branch catalog + classification (ADR-0031) ───────────────────────────────
  server.tool(
    "sync_branches",
    "Read a git repo's local branches, classify each (kind/environment/base) and upsert them into the branch catalog for a GitHub-style graph.",
    { project: z.string(), repo: z.string(), root: z.string(), remote: z.string().optional() },
    async ({ project, repo, root, remote }) => {
      return runLogged("sync_branches", { project, repo, root, remote }, async () => {
        const { syncBranches } = await import("../branches/sync.js");
        const recs = await syncBranches({ project, repo, root, remote: remote ?? null });
        return text(recs.map(jsonable));
      });
    },
  );
  server.tool(
    "list_branches",
    "List branches in the catalog (filterable by project/repo/kind), newest first.",
    { project: z.string().optional(), repo: z.string().optional(), kind: z.string().optional(), limit: z.number().int().min(1).max(500).default(200) },
    async ({ project, repo, kind, limit }) => {
      return runLogged("list_branches", { project, repo, kind, limit }, async () => {
        const { BranchStore } = await import("../branches/store.js");
        return text((await new BranchStore().list({ project, repo, kind, limit })).map(jsonable));
      });
    },
  );
  server.tool(
    "delete_branch",
    "Delete ONE branch from the catalog by (project, repo, name).",
    { project: z.string(), repo: z.string(), name: z.string() },
    async ({ project, repo, name }) => {
      return runLogged("delete_branch", { project, repo, name }, async () => {
        const { BranchStore } = await import("../branches/store.js");
        return text({ project, repo, name, deleted: await new BranchStore().delete(project, repo, name) });
      });
    },
  );

  // ── engineering roles (H11): assist the engineer's decision ──────────────────
  server.tool(
    "list_roles",
    "List engineering roles (review/pair/gate) for a project.",
    { project: z.string() },
    async ({ project }) => {
      return runLogged("list_roles", { project }, async () => {
        const { RoleStore } = await import("../roles/store.js");
        return text((await new RoleStore().list(project)).map(jsonable));
      });
    },
  );
  server.tool(
    "write_role",
    "Create/update ONE engineering role (persona/lens + mode review|pair|gate + severity + binding).",
    {
      project: z.string(),
      name: z.string(),
      lens: z.string(),
      mode: z.enum(["review", "pair", "gate"]).default("review"),
      severity: z.enum(["advisory", "blocking"]).default("advisory"),
      triggers: z.array(z.string()).optional(),
      denyGlobs: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
      description: z.string().default(""),
    },
    async ({ project, name, lens, mode, severity, triggers, denyGlobs, skills, description }) => {
      return runLogged("write_role", { project, name, mode, severity }, async () => {
        const { RoleStore } = await import("../roles/store.js");
        const { makeRole } = await import("../roles/schema.js");
        const role = makeRole({ name, lens, mode, severity, triggers: triggers ?? [], denyGlobs: denyGlobs ?? [], skills: skills ?? [], description });
        await new RoleStore().upsert(project, role);
        return text(jsonable(role));
      });
    },
  );
  server.tool(
    "seed_roles",
    "Seed the default role catalog (security, devops, qa, architect, devsecops) into a project.",
    { project: z.string() },
    async ({ project }) => {
      return runLogged("seed_roles", { project }, async () => {
        const { seedRoles } = await import("../roles/seed.js");
        const { RoleStore } = await import("../roles/store.js");
        return text({ seeded: await seedRoles(project, new RoleStore()) });
      });
    },
  );

  server.tool(
    "record_human_intervention",
    "Record a human intervention on a run (Tabla 4.3 #6 supervisión humana): reason + minutes.",
    { project: z.string(), run_id: z.string(), reason: z.string(), minutes: z.number().default(0) },
    async ({ project, run_id, reason, minutes }) => {
      return runLogged("record_human_intervention", { project, run_id, reason, minutes }, async () => {
        const { makeEvent } = await import("../memory/schemas.js");
        await new MemoryStore().logEvent(makeEvent({ project, run_id, type: "human_intervention", payload: { reason, minutes } }));
        return text({ ok: true, run_id, minutes });
      });
    },
  );

  // ── master indexer + definition builder (ADR-0030) ───────────────────────────
  server.tool(
    "index_repo",
    "Master indexer: build the repo map + (optionally) ingest markdown memory + sync ADRs for a project/repo in one pass.",
    { project: z.string(), root: z.string(), repo: z.string().optional(), memory: z.string().optional(), adr: z.string().optional() },
    async ({ project, root, repo, memory, adr }) => {
      return runLogged("index_repo", { project, root, repo, memory, adr }, async () => {
        const { indexRepo } = await import("../indexing/indexRepo.js");
        const a = mcpActor();
        const r = await indexRepo({ project, root, repo: repo ?? null, memoryDir: memory, adrDir: adr, actor: { id: a.id, role: a.role } });
        return text(jsonable(r));
      });
    },
  );

  server.tool(
    "build_definition",
    "Builder: construct and persist ONE skill or agent definition (from inline content or a scaffold template), keyed by (project, name).",
    {
      kind: z.enum(["skill", "agent"]),
      project: z.string(),
      name: z.string(),
      description: z.string().default(""),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      host: z.string().optional(),
      model: z.string().optional(),
    },
    async ({ kind, project, name, description, content, tags, host, model }) => {
      return runLogged("build_definition", { kind, project, name, description, tags, host, model }, async () => {
        const { buildDefinition } = await import("../builder/buildDefinition.js");
        const doc = await buildDefinition({ kind, project, name, description, content, tags, host, model });
        return text(jsonable(doc));
      });
    },
  );

  // ── graphify ─────────────────────────────────────────────────────────────────
  server.tool(
    "graphify",
    "Project the durable state as a graph. scope: all|symbols|memory. Symbols edges follow `refs`; memory edges follow `[[wiki-links]]`.",
    { project: z.string().optional(), scope: z.string().default("all"), fmt: z.string().default("json") },
    async ({ project, scope, fmt }) => {
      return runLogged("graphify", { project, scope, fmt }, async () => {
        const graphs = await graphify(new MongoGraphSource(getDb()), { project, scope: scope as Scope });
        const per: Record<string, unknown> = {};
        let totalNodes = 0;
        let totalEdges = 0;
        for (const [proj, g] of Object.entries(graphs)) {
          per[proj] = { nodes: g.nodes, edges: g.edges, counts: { nodes: g.nodes.length, edges: g.edges.length } };
          totalNodes += g.nodes.length;
          totalEdges += g.edges.length;
        }
        if (fmt === "dot") return text(graphToDot(graphs));
        if (project) return text(per[project]);
        return text({ projects: per, counts: { projects: Object.keys(graphs).length, nodes: totalNodes, edges: totalEdges } });
      });
    },
  );

  return server;
}

// graphify logic now lives in `../graph` (pure builders + serializers + GraphSource port).

export interface HttpOptions {
  host?: string;
  port?: number;
  path?: string;
  socketPath?: string;
  /** Required Bearer token; falsy means the endpoint is unauthenticated. */
  token?: string;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
}

/**
 * Serve the MCP over Streamable HTTP (the network transport). One fresh server +
 * transport is built per request (stateless: `sessionIdGenerator: undefined`) so
 * concurrent clients never share request-id state. All tools are request/response,
 * so no cross-request session is needed. Pair with a TLS proxy/tunnel to expose it.
 */
export async function mainHttp(opts: HttpOptions = {}): Promise<void> {
  const host = opts.host ?? process.env.AITL_MCP_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number.parseInt(process.env.AITL_MCP_PORT ?? "8000", 10);
  const path = opts.path ?? process.env.AITL_MCP_PATH ?? "/mcp";
  const socketPath = (opts.socketPath ?? process.env.AITL_MCP_SOCKET_PATH ?? "").trim() || undefined;
  const token = (opts.token ?? process.env.AITL_MCP_TOKEN ?? "").trim() || undefined;
  // DNS-rebinding protection is on unless explicitly disabled (needed for tunnels
  // whose public Host header is not in the allow-list — then set AITL_MCP_DNS_REBINDING=0).
  const dnsProtection = (process.env.AITL_MCP_DNS_REBINDING ?? "1") !== "0";
  const allowedHosts = (
    process.env.AITL_MCP_ALLOWED_HOSTS ??
    (socketPath ? "localhost,127.0.0.1" : `${host}:${port},localhost:${port},127.0.0.1:${port}`)
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        logEvent("http:unauthorized", { remote: req.socket.remoteAddress });
        unauthorized(res);
        return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: dnsProtection,
        allowedHosts,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      logEvent("http:error", { error: errorInfo(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });

  await connectDb();
  await new Promise<void>((listening) => {
    if (socketPath) {
      httpServer.listen(socketPath, listening);
    } else {
      httpServer.listen(port, host, listening);
    }
  });
  logEvent("server:start", {
    transport: "streamable-http",
    url: socketPath ? `http+unix://${encodeURIComponent(socketPath)}:${path}` : `http://${host}:${port}${path}`,
    socketPath: socketPath ?? null,
    auth: token ? "bearer" : "none",
    dnsRebindingProtection: dnsProtection,
    allowedHosts,
    db: maskUri(settings.mongodbUri),
    logFile: logFile ?? null,
  });
}

/**
 * Connect to MongoDB with primary→fallback resolution, logging each attempt and the
 * URI that won. Never throws: if every URI fails we log `db:error` and let the server
 * start anyway, so individual tools fail with a clear message instead of crash-looping.
 */
async function connectDb(): Promise<void> {
  try {
    const result = await connectWithFallback({
      onAttempt: (a) => logEvent("db:attempt", { label: a.label, uri: a.uri, ok: a.ok, error: a.error }),
    });
    logEvent("db:connected", { uri: result.uri, db: result.dbName, via: result.label, serverVersion: result.serverVersion ?? null });
    try {
      const user = await bootstrapBaseUser();
      logEvent("user:bootstrap", { status: user.status, username: user.username ?? null, email: user.email ?? null, role: user.role ?? null, generated: user.generated ?? false });
      // Surface the auto-generated root credentials exactly once (logs only).
      if (user.generated && user.password) {
        logEvent("user:bootstrap:generated", { username: user.username, password: user.password, note: "local root auto-generated — save this password; it is shown only once." });
      }
    } catch (err) {
      logEvent("user:bootstrap:error", { error: errorInfo(err) });
    }
  } catch (err) {
    logEvent("db:error", { error: errorInfo(err) });
  }
}

/** Entry point — run the MCP server over stdio (default) or HTTP (AITL_MCP_TRANSPORT=http). */
export async function main(): Promise<void> {
  const transport = (process.env.AITL_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    await mainHttp();
    return;
  }
  logEvent("server:start", {
    transport: "stdio",
    cwd: process.cwd(),
    node: process.version,
    db: maskUri(settings.mongodbUri),
    logFile: logFile ?? null,
  });
  await connectDb();
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  logEvent("server:connected", { transport: "stdio" });
}

// Run when invoked directly (tsx src/mcpserver/server.ts or node dist/mcpserver/server.js).
const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
