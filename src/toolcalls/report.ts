/**
 * Aggregation over `mcp_tool_calls` (ADR pending): per {project, tool}, how often it
 * ran, its success rate/latency, and — grouped further by an identifying field pulled
 * out of `args` (slug/name/path/dir/id/query/root) — WHAT it actually hydrated (read)
 * or created/mutated (write). Shared by `scripts/toolCallsReport.ts` (CLI) and
 * `GET /api/tool-calls` (web UI "ToolCalls" tab) so both read the exact same shape.
 *
 * "write" vs "read" is derived from `TOOL_RBAC` (src/mcpserver/server.ts): any tool
 * with an RBAC entry mutates durable state: everything else is a read/hydrate call.
 */

import { McpToolCallModel } from "../models/mcpToolCall.model.js";
import { TOOL_RBAC } from "../mcpserver/server.js";

/** Per {project, tool}: volume, success rate, latency, first/last seen, and a sample of
 *  the actual last payload — the evidence that the call really hydrated/created content. */
export interface ToolSummaryRow {
  _id: { project: string | null; tool: string };
  calls: number;
  ok: number;
  failed: number;
  avgMs: number | null;
  lastTs: Date;
  firstTs: Date;
  /** Redacted `args_preview` of the most recent call — what was asked for. */
  lastArgsPreview: string | null;
  /** Redacted `result_preview` of the most recent successful call — proof of what came back. */
  lastResultPreview: string | null;
  /** `error_message` of the most recent failed call, if any. */
  lastErrorMessage: string | null;
}

/** Per {project, tool, target}: what specific resource was hydrated/created, how often,
 *  and a sample of the actual content returned for that target. */
export interface TargetRow {
  _id: { project: string | null; tool: string; target: string };
  calls: number;
  ok: number;
  failed: number;
  lastTs: Date;
  lastResultPreview: string | null;
}

/** Preview strings are stored redacted but uncapped (up to AITL_MCP_CONTEXT_CHARS,
 *  100k by default) — clip before shipping them over HTTP/stdout. */
const EVIDENCE_CHARS = 800;
function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > EVIDENCE_CHARS ? `${value.slice(0, EVIDENCE_CHARS)}… [+${value.length - EVIDENCE_CHARS} chars]` : value;
}

export type ToolCallKind = "read" | "write";

/** First identifying field present in `args`, in priority order — covers every
 *  tool's dominant "what did this touch" field (repomap/memory/skills/agents/decisions/…). */
export const TARGET_FIELD_EXPR = {
  $let: {
    vars: {
      candidates: [
        "$args.slug",
        "$args.name",
        "$args.path",
        "$args.dir",
        "$args.id",
        "$args.query",
        "$args.root",
      ],
    },
    in: {
      $ifNull: [
        {
          $first: {
            $filter: {
              input: "$$candidates",
              cond: { $and: [{ $ne: ["$$this", null] }, { $ne: ["$$this", ""] }] },
            },
          },
        },
        "(sin identificador)",
      ],
    },
  },
};

export async function summaryByTool(match: Record<string, unknown>): Promise<ToolSummaryRow[]> {
  const rows = await McpToolCallModel.aggregate([
    { $match: match },
    // $last below picks the value from the chronologically last doc in each group —
    // only guaranteed if the input arrives in ts order.
    { $sort: { ts: 1 } },
    {
      $group: {
        _id: { project: "$project", tool: "$tool" },
        calls: { $sum: 1 },
        ok: { $sum: { $cond: ["$ok", 1, 0] } },
        failed: { $sum: { $cond: ["$ok", 0, 1] } },
        avgMs: { $avg: "$ms" },
        lastTs: { $max: "$ts" },
        firstTs: { $min: "$ts" },
        lastArgsPreview: { $last: "$args_preview" },
        lastResultPreview: { $last: { $cond: ["$ok", "$result_preview", null] } },
        lastErrorMessage: { $last: { $cond: ["$ok", null, "$error_message"] } },
      },
    },
    { $sort: { "_id.project": 1, calls: -1 } },
  ]);
  return rows.map((r) => ({
    ...r,
    lastArgsPreview: clip(r.lastArgsPreview),
    lastResultPreview: clip(r.lastResultPreview),
    lastErrorMessage: clip(r.lastErrorMessage),
  }));
}

export async function topTargets(match: Record<string, unknown>): Promise<TargetRow[]> {
  const rows = await McpToolCallModel.aggregate([
    { $match: match },
    { $addFields: { target: TARGET_FIELD_EXPR } },
    { $sort: { ts: 1 } },
    {
      $group: {
        _id: { project: "$project", tool: "$tool", target: "$target" },
        calls: { $sum: 1 },
        ok: { $sum: { $cond: ["$ok", 1, 0] } },
        failed: { $sum: { $cond: ["$ok", 0, 1] } },
        lastTs: { $max: "$ts" },
        lastResultPreview: { $last: { $cond: ["$ok", "$result_preview", null] } },
      },
    },
    { $sort: { "_id.project": 1, "_id.tool": 1, calls: -1 } },
  ]);
  return rows.map((r) => ({ ...r, lastResultPreview: clip(r.lastResultPreview) }));
}

/** Any tool listed in TOOL_RBAC mutates durable state (create/update/delete); the rest
 *  are reads/hydrations, never RBAC-gated by construction of that map. */
export function kind(tool: string): ToolCallKind {
  return tool in TOOL_RBAC ? "write" : "read";
}

export interface ToolCallsReport {
  summary: ToolSummaryRow[];
  targets: TargetRow[];
}

export async function toolCallsReport(match: Record<string, unknown>): Promise<ToolCallsReport> {
  const [summary, targets] = await Promise.all([summaryByTool(match), topTargets(match)]);
  return { summary, targets };
}
