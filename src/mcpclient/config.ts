/**
 * `.mcp.json` loader — the standard MCP server manifest (the same shape Claude Code
 * and other MCP hosts read): `{"mcpServers": {name: {command, args?, env?, cwd?}}}`.
 *
 * Reusing the standard means a workspace already configured for Claude Code exposes
 * exactly the same servers to `aitl run --mcp` with zero extra config (ADR-0041).
 * zod is allowed here by convention (MCP/config params only).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const McpServerSpecSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
});

export const McpConfigSchema = z.object({
  mcpServers: z.record(McpServerSpecSchema).default({}),
});

export type McpServerSpec = z.infer<typeof McpServerSpecSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Resolve and parse a `.mcp.json`. `pathOrDir` may be the file itself or a directory
 * containing one (default: cwd). Returns `null` when the file simply doesn't exist;
 * THROWS on malformed JSON/shape — that's a user error worth failing loudly on.
 */
export function loadMcpConfig(pathOrDir?: string): { path: string; config: McpConfig } | null {
  const cand = pathOrDir ?? process.cwd();
  const path = existsSync(cand) && statSync(cand).isFile() ? cand : join(cand, ".mcp.json");
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${path}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = McpConfigSchema.safeParse(parsed);
  if (!res.success) {
    const first = res.error.issues[0];
    throw new Error(
      `${path}: expected {"mcpServers": {name: {command, args?, env?, cwd?}}}` +
        (first ? ` — ${first.path.join(".")}: ${first.message}` : ""),
    );
  }
  return { path, config: res.data };
}
