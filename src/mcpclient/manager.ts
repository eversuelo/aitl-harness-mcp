/**
 * Runtime MCP mount manager (extends ADR-0041). The boot-time `mountMcpTools` is a
 * one-shot: whatever `.mcp.json` said when the session started is what you get.
 * This manager makes mounts a LIVE set — add, replace, remove and reload servers
 * mid-session — by remembering, per server, the Client it owns and the exact tool
 * names it registered, so an unmount removes precisely those tools and nothing else.
 *
 * It also closes a long-standing gap: the harness always EXPOSED an MCP server but
 * never consumed its own — `selfServerSpec()` spawns `aitl mcp` with the current
 * runtime (node dist / tsx src), giving the loop the durable-memory tools
 * (search_memory, record_decision, …) like any external MCP host would have.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolRegistry } from "../tools/base.js";
import { mountClientTools, withTimeout } from "./client.js";
import { type McpServerSpec, loadMcpConfig } from "./config.js";

interface MountedServer {
  spec: McpServerSpec;
  client: Client;
  tools: string[];
}

export interface McpManagerOpts {
  connectTimeoutMs?: number; // default 15_000
  callTimeoutMs?: number; // default 60_000 (per remote tool call)
  /** Client factory seam — tests inject an InMemoryTransport-backed client here. */
  connect?: (name: string, spec: McpServerSpec) => Promise<Client>;
}

export interface McpServerStatus {
  name: string;
  command: string;
  tools: number;
}

/** The harness's own MCP server, spawned with the same runtime as this process. */
export function selfServerSpec(): McpServerSpec {
  const entry = process.argv[1] ?? "aitl";
  const isTs = entry.endsWith(".ts");
  const hasTsxLoader = process.execArgv.some((a) => a.includes("tsx"));
  const loader = isTs && !hasTsxLoader ? ["--import", "tsx"] : [];
  // The stdio transport only forwards a minimal safe env — pass the harness's own
  // config through explicitly so the child sees the same DB/profile/model setup.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && /^(AITL_|MONGODB_|LMSTUDIO_|OPENROUTER_|ANTHROPIC_|OPENAI_|MODEL_)/.test(k)) env[k] = v;
  }
  return {
    command: process.execPath,
    args: [...process.execArgv, ...loader, entry, "mcp"],
    env,
  };
}

export class McpManager {
  private servers = new Map<string, MountedServer>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: McpManagerOpts = {},
  ) {}

  list(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      command: [s.spec.command, ...(s.spec.args ?? [])].join(" "),
      tools: s.tools.length,
    }));
  }

  private async connect(name: string, spec: McpServerSpec): Promise<Client> {
    if (this.opts.connect) return this.opts.connect(name, spec);
    const client = new Client({ name: "aitl-harness", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...getDefaultEnvironment(), ...spec.env },
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      stderr: "ignore", // keep the REPL clean; failures surface via connect errors
    });
    await withTimeout(
      client.connect(transport),
      this.opts.connectTimeoutMs ?? 15_000,
      `connect to MCP server '${name}' (${spec.command})`,
    );
    return client;
  }

  /** Mount (or replace — "edit") one server. Throws when it cannot come up. */
  async mount(name: string, spec: McpServerSpec): Promise<McpServerStatus> {
    await this.unmount(name);
    const client = await this.connect(name, spec);
    let tools: string[];
    try {
      tools = await mountClientTools(client, name, this.registry, this.opts.callTimeoutMs);
    } catch (err) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    this.servers.set(name, { spec, client, tools });
    return { name, command: [spec.command, ...(spec.args ?? [])].join(" "), tools: tools.length };
  }

  /** Unmount one server: its tools leave the registry, its child dies. */
  async unmount(name: string): Promise<boolean> {
    const s = this.servers.get(name);
    if (!s) return false;
    for (const t of s.tools) this.registry.unregister(t);
    this.servers.delete(name);
    try {
      await s.client.close();
    } catch {
      // a wedged transport must not block the REPL
    }
    return true;
  }

  /**
   * Mount every server declared in `.mcp.json` (same degrade contract as boot: a
   * server that fails to come up is reported and skipped, never fatal).
   */
  async mountFromConfig(
    pathOrDir?: string,
    onEvent?: (ev: { server: string; ok: boolean; tools?: number; error?: string }) => void,
  ): Promise<McpServerStatus[]> {
    const loaded = loadMcpConfig(pathOrDir);
    const mounted: McpServerStatus[] = [];
    if (!loaded) return mounted;
    for (const [name, spec] of Object.entries(loaded.config.mcpServers)) {
      try {
        const st = await this.mount(name, spec);
        mounted.push(st);
        onEvent?.({ server: name, ok: true, tools: st.tools });
      } catch (err) {
        onEvent?.({ server: name, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return mounted;
  }

  /** Close every mounted server. Never throws. */
  async closeAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) await this.unmount(name);
  }
}
