import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolRegistry } from "../tools/base.js";
import { loadMcpConfig } from "./config.js";
import { mountClientTools, mountMcpTools } from "./client.js";

// ── loadMcpConfig ────────────────────────────────────────────────────────────

test("loadMcpConfig parses the standard mcpServers manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-mcp-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: { db: { command: "node", args: ["server.js"], env: { FOO: "bar" } } },
    }),
  );
  const loaded = loadMcpConfig(dir);
  assert.ok(loaded);
  assert.deepEqual(Object.keys(loaded.config.mcpServers), ["db"]);
  assert.equal(loaded.config.mcpServers.db.command, "node");
  assert.deepEqual(loaded.config.mcpServers.db.env, { FOO: "bar" });
});

test("loadMcpConfig returns null when no .mcp.json exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-mcp-empty-"));
  assert.equal(loadMcpConfig(dir), null);
});

test("loadMcpConfig throws a clear error on a malformed manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-mcp-bad-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { db: { args: [] } } }));
  assert.throws(() => loadMcpConfig(dir), /command/);
});

// ── mountClientTools (in-memory server, no child processes) ─────────────────

async function linkedClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  server.tool("echo", "Echo a message back.", { msg: z.string() }, async ({ msg }) => ({
    content: [{ type: "text", text: `echo:${msg}` }],
  }));
  server.tool("boom", "Always fails.", {}, async () => ({
    content: [{ type: "text", text: "it broke" }],
    isError: true,
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "aitl-test", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

test("mountClientTools registers namespaced tools that proxy to the server", async () => {
  const client = await linkedClient();
  const registry = new ToolRegistry();
  const names = await mountClientTools(client, "test", registry);
  assert.deepEqual(names.sort(), ["mcp__test__boom", "mcp__test__echo"]);

  // Schema passes through to the provider-facing schemas.
  const schema = registry.schemas().find((s) => s.name === "mcp__test__echo");
  assert.ok(schema, "echo schema is exposed to the model");

  // Calls proxy through and return the text content.
  const out = await registry.call("mcp__test__echo", { msg: "hi" });
  assert.equal(out, "echo:hi");
  await client.close();
});

test("a remote isError result maps to the registry's [tool error] convention", async () => {
  const client = await linkedClient();
  const registry = new ToolRegistry();
  await mountClientTools(client, "test", registry);
  const out = await registry.call("mcp__test__boom", {});
  assert.match(out, /^\[tool error\] it broke/);
  await client.close();
});

test("remote tools without a readOnlyHint require approval (ADR-0040 synergy)", async () => {
  const client = await linkedClient();
  const registry = new ToolRegistry();
  await mountClientTools(client, "test", registry);
  assert.equal(registry.get("mcp__test__echo")?.requiresApproval, true);
  await client.close();
});

// ── mountMcpTools (degradation) ──────────────────────────────────────────────

test("a server that cannot start degrades gracefully and close() never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-mcp-degrade-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { ghost: { command: "definitely-not-a-command-xyz" } } }),
  );
  const registry = new ToolRegistry();
  const events: { server: string; ok: boolean }[] = [];
  const mount = await mountMcpTools({
    registry,
    configPath: join(dir, ".mcp.json"),
    connectTimeoutMs: 5_000,
    onEvent: (ev) => events.push({ server: ev.server, ok: ev.ok }),
  });
  assert.equal(mount.servers.length, 1);
  assert.equal(mount.servers[0].ok, false);
  assert.ok(mount.servers[0].error, "the failure reason is reported");
  assert.deepEqual(mount.tools, []);
  assert.deepEqual(events, [{ server: "ghost", ok: false }]);
  await mount.close(); // must not throw
});

test("mountMcpTools with no manifest is a silent no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-mcp-none-"));
  const mount = await mountMcpTools({ registry: new ToolRegistry(), cwd: dir });
  assert.deepEqual(mount.servers, []);
  assert.deepEqual(mount.tools, []);
  await mount.close();
});
