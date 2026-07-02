/**
 * MCP client (ADR-0041): mount remote MCP servers' tools into the harness ToolRegistry.
 *
 * The harness has always EXPOSED an MCP server; this is the other direction — the
 * loop CONSUMING external servers as tools. Each remote tool is registered as
 * `mcp__<server>__<tool>` (collision-free namespacing), its JSON Schema passes
 * through untouched, and non-read-only tools inherit `requiresApproval` so `--ask`
 * (ADR-0040) covers them too.
 *
 * Lifecycle is owned by the CALLER (the CLI): `runAgent` stays a pure library and
 * never owns child processes. A server that fails to start degrades gracefully —
 * the run continues with the servers that did come up.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolRegistry } from "../tools/base.js";
import { loadMcpConfig } from "./config.js";

export interface McpMountEvent {
  server: string;
  ok: boolean;
  tools?: number;
  error?: string;
}

export interface McpMount {
  /** Registered tool names (`mcp__<server>__<tool>`), across all servers. */
  tools: string[];
  servers: { name: string; ok: boolean; tools: number; error?: string }[];
  /** Close every connected client/transport. Never throws. */
  close(): Promise<void>;
}

export interface MountMcpOpts {
  registry: ToolRegistry;
  /** Explicit `.mcp.json` path; falls back to `<cwd>/.mcp.json`. */
  configPath?: string;
  cwd?: string;
  connectTimeoutMs?: number; // default 15_000
  callTimeoutMs?: number; // default 60_000 (per remote tool call)
  onEvent?: (ev: McpMountEvent) => void;
}

/** Flatten an MCP tool result's content into the registry's string convention. */
function contentToString(result: { content?: unknown; isError?: unknown }): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p: { type?: string; text?: string }) =>
      p?.type === "text" && typeof p.text === "string" ? p.text : JSON.stringify(p),
    )
    .join("\n");
  return result.isError === true ? `[tool error] ${text || "MCP tool returned an error"}` : text;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Pure, transport-agnostic core (testable with InMemoryTransport): list a connected
 * client's tools and register them. Returns the namespaced tool names.
 */
export async function mountClientTools(
  client: Client,
  serverName: string,
  registry: ToolRegistry,
  callTimeoutMs = 60_000,
): Promise<string[]> {
  const { tools } = await client.listTools();
  const names: string[] = [];
  for (const t of tools) {
    const name = `mcp__${serverName}__${t.name}`;
    // `annotations.readOnlyHint` is a recent SDK addition — read it defensively.
    const readOnly =
      (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true;
    registry.register({
      name,
      description: t.description ?? `${t.name} (MCP tool from '${serverName}')`,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      // Unknown side effects ⇒ require approval under --ask; only a declared
      // read-only hint opts a remote tool out.
      requiresApproval: !readOnly,
      run: async (args) => {
        const res = await client.callTool({ name: t.name, arguments: args }, undefined, {
          timeout: callTimeoutMs,
        });
        return contentToString(res as { content?: unknown; isError?: unknown });
      },
    });
    names.push(name);
  }
  return names;
}

/** Read `.mcp.json`, spawn/connect each server over stdio, and mount its tools. */
export async function mountMcpTools(opts: MountMcpOpts): Promise<McpMount> {
  const loaded = loadMcpConfig(opts.configPath ?? opts.cwd);
  const clients: Client[] = [];
  const servers: McpMount["servers"] = [];
  const allTools: string[] = [];

  if (loaded) {
    for (const [name, spec] of Object.entries(loaded.config.mcpServers)) {
      const client = new Client({ name: "aitl-harness", version: "0.1.0" });
      try {
        const transport = new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          // Merge over the SDK's safe default env so servers still see PATH etc.
          env: { ...getDefaultEnvironment(), ...spec.env },
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
          stderr: "ignore", // keep the harness terminal clean; failures surface via connect errors
        });
        await withTimeout(
          client.connect(transport),
          opts.connectTimeoutMs ?? 15_000,
          `connect to MCP server '${name}' (${spec.command})`,
        );
        const tools = await mountClientTools(client, name, opts.registry, opts.callTimeoutMs);
        clients.push(client);
        allTools.push(...tools);
        servers.push({ name, ok: true, tools: tools.length });
        opts.onEvent?.({ server: name, ok: true, tools: tools.length });
      } catch (err) {
        // A server that doesn't come up must not take the run down with it.
        try {
          await client.close();
        } catch {
          // best-effort cleanup
        }
        const error = err instanceof Error ? err.message : String(err);
        servers.push({ name, ok: false, tools: 0, error });
        opts.onEvent?.({ server: name, ok: false, error });
      }
    }
  }

  return {
    tools: allTools,
    servers,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
