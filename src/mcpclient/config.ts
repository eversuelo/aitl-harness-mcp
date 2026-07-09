/**
 * `.mcp.json` loader — the standard MCP server manifest (the same shape Claude Code
 * and other MCP hosts read): `{"mcpServers": {name: {command, args?, env?, cwd?}}}`.
 *
 * Reusing the standard means a workspace already configured for Claude Code exposes
 * exactly the same servers to `aitl run --mcp` with zero extra config (ADR-0041).
 * zod is allowed here by convention (MCP/config params only).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// ── manifest editing (`/mcp add|rm` persist here) ────────────────────────────

/** Raw manifest object, or a fresh skeleton when the file doesn't exist yet. */
function readRawManifest(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { mcpServers: {} };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: the manifest root must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const writeRawManifest = (path: string, raw: Record<string, unknown>): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
};

/**
 * Insert or replace one server entry, editing the RAW JSON so keys this schema does
 * not know about (other tools' config in the same file) are preserved verbatim.
 */
export function upsertMcpServer(path: string, name: string, spec: McpServerSpec): void {
  const parsed = McpServerSpecSchema.parse(spec);
  const raw = readRawManifest(path);
  const servers =
    typeof raw.mcpServers === "object" && raw.mcpServers !== null && !Array.isArray(raw.mcpServers)
      ? (raw.mcpServers as Record<string, unknown>)
      : {};
  // Drop empty defaults so the manifest stays as terse as a handwritten one.
  servers[name] = {
    command: parsed.command,
    ...(parsed.args.length ? { args: parsed.args } : {}),
    ...(Object.keys(parsed.env).length ? { env: parsed.env } : {}),
    ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
  };
  raw.mcpServers = servers;
  writeRawManifest(path, raw);
}

/** Remove one server entry. Returns whether it existed. */
export function removeMcpServer(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  const raw = readRawManifest(path);
  const servers = raw.mcpServers;
  if (typeof servers !== "object" || servers === null || !(name in (servers as Record<string, unknown>))) {
    return false;
  }
  delete (servers as Record<string, unknown>)[name];
  writeRawManifest(path, raw);
  return true;
}
