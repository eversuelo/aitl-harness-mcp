/**
 * Mongoose model for the `mcp_context` collection.
 *
 * An `mcp_context` doc is a complete MCP context snapshot supplied by a client (the
 * `save_mcp_context` tool) or produced by `capture-session`: messages, summary,
 * metadata, tags and arbitrary `context`. Rows feed `list_mcp_context`,
 * `search_mcp_context` (text/regex cascade over `content_text`), the `/api/context`
 * endpoints, and the knowledge-map graph projection.
 *
 * These collections had NO Zod schema and NO dedicated store — they were written/read
 * inline via the raw driver. This model mirrors the exact inline doc shape so Mongoose
 * writes documents byte-compatible with the pre-migration driver-written docs.
 * `BASE_SCHEMA_OPTS` keeps `minimize:false` so the empty `{}` sub-objects
 * (`context`, `metadata`) persist, matching the driver behaviour.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const MCP_CONTEXT_COLLECTION = "mcp_context";

const now = () => new Date();

const mcpContextSchema = new Schema(
  {
    context_id: { type: String, required: true }, // client-generated UUID (unique index)
    project: { type: String, required: true },
    title: { type: String, default: "" },
    summary: { type: String, default: "" },
    source: { type: String, default: "mcp" },
    model: { type: String, default: null },
    run_id: { type: String, default: null },
    tags: { type: [String], default: [] },
    // Dynamic client payloads — kept as Mixed (empty {} preserved via minimize:false).
    messages: { type: Schema.Types.Mixed, default: () => ({}) },
    context: { type: Schema.Types.Mixed, default: () => ({}) },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    content_text: { type: String, default: "" }, // text-index target for search_mcp_context
    repo: { type: String, default: null }, // repo sub-scope (ADR-0028)
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: MCP_CONTEXT_COLLECTION },
);

export type McpContext = InferSchemaType<typeof mcpContextSchema>;

export const McpContextModel = model("McpContext", mcpContextSchema);
