/**
 * Create collections, regular indexes, text indexes and Atlas Vector Search indexes.
 *
 * Idempotent: safe to run repeatedly (used by `scripts/initDb.ts`).
 *
 * The Atlas Vector Search index definition is the same JSON whether you run against
 * the local `mongodb-atlas-local` image or cloud Atlas. `numDimensions` is taken from
 * `settings.embeddingDims` and MUST match the active embedder (ADR-0002).
 */

import type { Db } from "mongodb";
import { settings } from "../config.js";
import { COLLECTIONS, getDb } from "./client.js";

// Collections that hold an `embedding` field and need a vector index.
export const VECTOR_COLLECTIONS = ["messages", "memory", "decisions"] as const;

export async function ensureCollections(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const name of COLLECTIONS) {
    if (!existing.has(name)) await db.createCollection(name);
  }
}

export async function ensureScalarIndexes(db: Db): Promise<void> {
  await db.collection("messages").createIndex({ run_id: 1, idx: 1 });
  await db.collection("messages").createIndex({ project: 1, category: 1 });
  await db.collection("memory").createIndex({ project: 1, slug: 1 }, { unique: true });
  await db.collection("memory").createIndex({ project: 1, category: 1 });
  await db.collection("memory").createIndex({ project: 1, repo: 1 }); // repo sub-scope (ADR-0028)
  await db.collection("decisions").createIndex({ project: 1, id: 1 }, { unique: true });
  // Append-only revision history (ADR-0027): one snapshot per archived version.
  await db.collection("decisions_history").createIndex({ project: 1, ref: 1, version: -1 }, { unique: true });
  await db.collection("memory_history").createIndex({ project: 1, ref: 1, version: -1 }, { unique: true });
  await db.collection("prompts").createIndex({ project: 1, created_at: -1 });
  await db.collection("prompts").createIndex({ project: 1, source: 1, created_at: -1 });
  await db.collection("prompts").createIndex({ project: 1, tags: 1 });
  await db.collection("mcp_context").createIndex({ project: 1, created_at: -1 });
  await db.collection("mcp_context").createIndex({ project: 1, source: 1, created_at: -1 });
  await db.collection("mcp_context").createIndex({ project: 1, run_id: 1 });
  await db.collection("mcp_context").createIndex({ project: 1, tags: 1 });
  await db.collection("mcp_tool_calls").createIndex({ project: 1, ts: -1 });
  await db.collection("mcp_tool_calls").createIndex({ tool: 1, ts: -1 });
  await db.collection("mcp_tool_calls").createIndex({ ok: 1, ts: -1 });
  await db.collection("users").createIndex({ username: 1 }, { unique: true });
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("users").createIndex({ created_at: -1 });
  await db.collection("users").createIndex({ role: 1 });
  await db.collection("audit").createIndex({ ts: -1 });
  await db.collection("audit").createIndex({ actor_id: 1, ts: -1 });
  await db.collection("audit").createIndex({ resource: 1, action: 1, ts: -1 });
  await db.collection("audit").createIndex({ ok: 1, ts: -1 });
  await db.collection("symbols").createIndex({ project: 1, file: 1 });
  await db.collection("symbols").createIndex({ project: 1, name: 1 });
  await db.collection("symbols").createIndex({ project: 1, repo: 1 }); // repo sub-scope (ADR-0028)
  await db.collection("mcp_context").createIndex({ project: 1, repo: 1 }); // repo sub-scope (ADR-0028)
  await db.collection("conventions").createIndex({ project: 1, scope_glob: 1 });
  await db.collection("runs").createIndex({ started_at: -1 });
  await db.collection("events").createIndex({ run_id: 1, ts: 1 });
  // Software/repo catalog (ADR-0028).
  await db.collection("softwares").createIndex({ name: 1 }, { unique: true });
  await db.collection("softwares").createIndex({ updated_at: -1 });
  await db.collection("repos").createIndex({ project: 1, name: 1 }, { unique: true });
  await db.collection("repos").createIndex({ software: 1 });
  await db.collection("repos").createIndex({ updated_at: -1 });
}

export async function ensureTextIndexes(db: Db): Promise<void> {
  // Lexical search / fallback when embeddings are unavailable.
  await db.collection("messages").createIndex({ content: "text" });
  await db.collection("memory").createIndex({ body: "text", description: "text" });
  await db.collection("decisions").createIndex({ title: "text", context: "text" });
  await db.collection("prompts").createIndex({ title: "text", prompt: "text" });
  await db.collection("mcp_context").createIndex({ title: "text", content_text: "text" });
  await db.collection("mcp_tool_calls").createIndex({ tool: "text", args_preview: "text", result_preview: "text", error_message: "text" });
  await db.collection("softwares").createIndex({ name: "text", display_name: "text", description: "text" });
  await db.collection("repos").createIndex({ name: "text", description: "text", remote: "text" });
}

/** Atlas Vector Search index definition for an `embedding` field. */
function vectorIndexModel(dims: number) {
  return {
    name: "vector_index",
    type: "vectorSearch" as const,
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: dims, similarity: "cosine" },
        { type: "filter", path: "project" },
        { type: "filter", path: "category" },
        { type: "filter", path: "type" },
      ],
    },
  };
}

/**
 * Create Atlas Vector Search indexes via the Search index management API.
 *
 * Requires a Search-enabled deployment (the `mongodb-atlas-local` image or Atlas).
 * On a plain mongod this throws — caught and surfaced clearly.
 */
export async function ensureVectorIndexes(db: Db): Promise<void> {
  const model = vectorIndexModel(settings.embeddingDims);
  for (const name of VECTOR_COLLECTIONS) {
    const coll = db.collection(name);
    try {
      const existing = new Set((await coll.listSearchIndexes().toArray()).map((ix) => ix.name));
      if (!existing.has("vector_index")) {
        await coll.createSearchIndex(model as never);
      }
    } catch (exc) {
      throw new Error(
        `Vector index creation failed on '${name}'. Ensure you are running the ` +
          `mongodb/mongodb-atlas-local image or a cloud Atlas cluster (plain mongod ` +
          `has no Vector Search). Original error: ${String(exc)}`,
      );
    }
  }
}

export async function initIndexes(db?: Db): Promise<Db> {
  const database = db ?? getDb();
  await ensureCollections(database);
  await ensureScalarIndexes(database);
  await ensureTextIndexes(database);
  await ensureVectorIndexes(database);
  return database;
}
