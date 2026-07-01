/**
 * Mongoose model for the `mcp_tool_calls` collection.
 *
 * One row per MCP tool invocation (see `persistMcpToolCall`/`runLogged`): the tool name,
 * project, success flag, redacted args/result/error (full + preview), and duration. It is
 * the durable telemetry trail behind every MCP tool call, searched by the
 * `mcp_tool_calls` text index (tool/args_preview/result_preview/error_message).
 *
 * This collection had NO Zod schema and NO dedicated store — it was written inline via the
 * raw driver. This model mirrors the exact inline doc shape so Mongoose writes documents
 * byte-compatible with the pre-migration driver-written docs. `BASE_SCHEMA_OPTS` keeps
 * `minimize:false` so an empty `{}` args/result persists, matching the driver behaviour.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";

export const MCP_TOOL_CALLS_COLLECTION = "mcp_tool_calls";

const now = () => new Date();

const mcpToolCallSchema = new Schema(
  {
    project: { type: String, default: null },
    tool: { type: String, required: true },
    ok: { type: Boolean, required: true },
    // Dynamic redacted payloads — kept as Mixed (empty {} preserved via minimize:false).
    args: { type: Schema.Types.Mixed, default: () => ({}) },
    args_preview: { type: String, default: "" },
    result: { type: Schema.Types.Mixed },
    result_preview: { type: String },
    error: { type: Schema.Types.Mixed },
    error_message: { type: String },
    ms: { type: Number },
    ts: { type: Date, default: now },
  },
  { ...BASE_SCHEMA_OPTS, collection: MCP_TOOL_CALLS_COLLECTION },
);

export type McpToolCall = InferSchemaType<typeof mcpToolCallSchema>;

export const McpToolCallModel = model("McpToolCall", mcpToolCallSchema);
