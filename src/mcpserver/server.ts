/**
 * MCP server exposing AITL-Harness durable artifacts as MCP tools.
 *
 * Tool surface (memory-backend role): search_memory · write_memory · ingest_path ·
 * get_repomap · list_decisions · record_decision · graphify.
 *
 * Every tool is project-scoped. Returns are plain JSON-able values (ObjectId / Date
 * are sanitized) so any MCP client can consume them. Mirrors aitl/mcpserver/server.py.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { embedOne } from "../ingest/embedder.js";
import { extractLinks, parseMarkdownDir } from "../ingest/markdown.js";
import { Classifier } from "../memory/classifier.js";
import { MEMORY_TYPES, type MemoryType, makeMemoryDoc } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";
import { ADRStore } from "../decisions/adr.js";
import { RepoMap } from "../repomap/store.js";

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

async function runLogged<T>(tool: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  logEvent("tool:start", { tool, args: preview(args) });
  try {
    const result = await fn();
    logEvent("tool:end", { tool, ms: Date.now() - started, result: preview(result) });
    return result;
  } catch (err) {
    logEvent("tool:error", { tool, ms: Date.now() - started, error: errorInfo(err) });
    throw err;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    },
    async ({ project, slug, body, description, type, tags }) => {
      return runLogged("write_memory", { project, slug, body, description, type, tags }, async () => {
        const t: MemoryType = (MEMORY_TYPES as readonly string[]).includes(type) && type !== "synthesis"
          ? (type as MemoryType)
          : "project";
        const doc = makeMemoryDoc({ project, slug, type: t, description, body, links: extractLinks(body), tags: tags ?? [] });
        await new Classifier().classifyMemory(doc);
        doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
        await new MemoryStore().upsertMemory(doc);
        return text({ slug: doc.slug, category: doc.category, type: doc.type });
      });
    },
  );

  server.tool(
    "ingest_path",
    "Bulk-ingest a directory of markdown memory files into a project.",
    { path: z.string(), project: z.string() },
    async ({ path, project }) => {
      return runLogged("ingest_path", { path, project }, async () => {
        const store = new MemoryStore();
        const clf = new Classifier();
        const docs = await parseMarkdownDir(path, project);
        for (const doc of docs) {
          await clf.classifyMemory(doc);
          doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
          await store.upsertMemory(doc);
        }
        return text({ ingested: docs.length, project });
      });
    },
  );

  // ── repo map ───────────────────────────────────────────────────────────────
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
    "Return the tree-sitter + PageRank repo map for a project. If `root` is given it is (re)built first; otherwise the cached map is rendered.",
    { project: z.string(), root: z.string().optional(), maxTokens: z.number().int().default(1024) },
    async ({ project, root, maxTokens }) => {
      return runLogged("get_repomap", { project, root, maxTokens }, async () => {
        const rm = new RepoMap();
        if (root) await rm.build(root, project);
        return text(await rm.render(project, { maxTokens }));
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
        await new ADRStore().upsert(adr);
        return text({ id: adr.id, title: adr.title, status: adr.status });
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
        const db = getDb();
        const projects = project ? [project] : await allProjects(db);
        const per: Record<string, unknown> = {};
        let totalNodes = 0;
        let totalEdges = 0;
        for (const proj of projects) {
          const { nodes, edges } = await graphForProject(db, proj, scope);
          per[proj] = { nodes, edges, counts: { nodes: nodes.length, edges: edges.length } };
          totalNodes += nodes.length;
          totalEdges += edges.length;
        }
        if (fmt === "dot") return text(graphToDot(per));
        if (project) return text(per[project]);
        return text({ projects: per, counts: { projects: projects.length, nodes: totalNodes, edges: totalEdges } });
      });
    },
  );

  return server;
}

// ── graphify helpers (mirror server.py) ────────────────────────────────────────
async function allProjects(db: ReturnType<typeof getDb>): Promise<string[]> {
  const names = new Set<string>();
  for (const coll of ["symbols", "memory", "decisions"]) {
    for (const n of await db.collection(coll).distinct("project")) if (n) names.add(String(n));
  }
  return [...names].sort();
}

async function graphForProject(db: ReturnType<typeof getDb>, project: string, scope: string) {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];

  if (scope === "all" || scope === "symbols") {
    const syms = await db.collection("symbols").find({ project }, { projection: { embedding: 0 } }).toArray();
    const byName = new Map<string, string>();
    for (const s of syms) {
      const nid = `sym:${s.file}::${s.name}`;
      if (!byName.has(s.name)) byName.set(s.name, nid);
      nodes.push({ id: nid, label: s.name, kind: "symbol", project, file: s.file, pagerank: Number(s.pagerank ?? 0) });
    }
    for (const s of syms) {
      const src = `sym:${s.file}::${s.name}`;
      for (const ref of (s.refs as string[]) ?? []) {
        const tgt = byName.get(ref);
        if (tgt && tgt !== src) edges.push({ source: src, target: tgt, type: "ref" });
      }
    }
  }

  if (scope === "all" || scope === "memory") {
    const mems = await db.collection("memory").find({ project }, { projection: { embedding: 0 } }).toArray();
    const slugs = new Set(mems.map((m) => m.slug as string));
    for (const m of mems) nodes.push({ id: `mem:${m.slug}`, label: m.slug, kind: "memory", project, category: m.category });
    for (const m of mems) {
      for (const link of (m.links as string[]) ?? []) {
        if (slugs.has(link)) edges.push({ source: `mem:${m.slug}`, target: `mem:${link}`, type: "link" });
      }
    }
  }

  return { nodes, edges };
}

function graphToDot(perProject: Record<string, any>): string {
  const lines = ["digraph aitl {", "  rankdir=LR; node [shape=box];"];
  for (const [proj, g] of Object.entries(perProject)) {
    lines.push(`  subgraph "cluster_${proj}" { label="${proj}";`);
    for (const n of g.nodes) lines.push(`    "${proj}::${n.id}" [label="${n.label}"];`);
    lines.push("  }");
    for (const e of g.edges) lines.push(`  "${proj}::${e.source}" -> "${proj}::${e.target}";`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Entry point — run the MCP server over stdio. */
export async function main(): Promise<void> {
  logEvent("server:start", {
    transport: "stdio",
    cwd: process.cwd(),
    node: process.version,
    db: maskUri(process.env.MONGODB_URI),
    logFile: logFile ?? null,
  });
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
