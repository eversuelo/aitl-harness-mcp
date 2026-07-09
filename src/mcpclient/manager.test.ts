import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolRegistry } from "../tools/base.js";
import { removeMcpServer, upsertMcpServer } from "./config.js";
import { McpManager, selfServerSpec } from "./manager.js";

// In-memory MCP server whose single tool echoes with a per-server tag (so a
// replaced mount is distinguishable from the original).
async function linkedClient(tag: string, toolName = "echo"): Promise<Client> {
  const server = new McpServer({ name: `test-${tag}`, version: "0.0.1" });
  server.tool(toolName, `Echo (${tag}).`, { msg: z.string() }, async ({ msg }) => ({
    content: [{ type: "text", text: `${tag}:${msg}` }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "aitl-test", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

const spec = { command: "fake", args: [], env: {} };

test("manager: mount registers namespaced tools; unmount removes exactly those", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "keep_me", description: "", inputSchema: {}, run: async () => "ok" });
  const manager = new McpManager(registry, { connect: (name) => linkedClient(name) });

  const st = await manager.mount("srv", spec);
  assert.equal(st.tools, 1);
  assert.equal(await registry.call("mcp__srv__echo", { msg: "x" }), "srv:x");
  assert.deepEqual(manager.list().map((s) => s.name), ["srv"]);

  assert.equal(await manager.unmount("srv"), true);
  assert.match(await registry.call("mcp__srv__echo", { msg: "x" }), /unknown tool/);
  assert.ok(registry.get("keep_me"), "unrelated tools survive the unmount");
  assert.equal(await manager.unmount("srv"), false);
});

test("manager: mounting the same name replaces the previous server (edit/update)", async () => {
  const registry = new ToolRegistry();
  let generation = 0;
  const manager = new McpManager(registry, {
    connect: () => linkedClient(`v${++generation}`),
  });
  await manager.mount("srv", spec);
  assert.equal(await registry.call("mcp__srv__echo", { msg: "a" }), "v1:a");
  await manager.mount("srv", spec);
  assert.equal(await registry.call("mcp__srv__echo", { msg: "a" }), "v2:a", "the new mount answers");
  assert.equal(manager.list().length, 1, "still a single server entry");
});

test("manager: closeAll unmounts everything and never throws", async () => {
  const registry = new ToolRegistry();
  const manager = new McpManager(registry, { connect: (name) => linkedClient(name) });
  await manager.mount("a", spec);
  await manager.mount("b", spec);
  await manager.closeAll();
  assert.deepEqual(manager.list(), []);
  assert.match(await registry.call("mcp__a__echo", { msg: "x" }), /unknown tool/);
});

test("manager: a failing connect leaves no traces", async () => {
  const registry = new ToolRegistry();
  const manager = new McpManager(registry, {
    connect: async () => {
      throw new Error("no such server");
    },
  });
  await assert.rejects(() => manager.mount("ghost", spec), /no such server/);
  assert.deepEqual(manager.list(), []);
});

test("selfServerSpec spawns this runtime with the `mcp` subcommand", () => {
  const s = selfServerSpec();
  assert.equal(s.command, process.execPath);
  assert.equal(s.args?.[s.args.length - 1], "mcp");
});

// ── manifest editing ─────────────────────────────────────────────────────────

test("upsertMcpServer creates the manifest and keeps entries terse", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aitl-mcp-edit-")), ".mcp.json");
  upsertMcpServer(path, "db", { command: "node", args: ["s.js"], env: {} });
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(raw, { mcpServers: { db: { command: "node", args: ["s.js"] } } });
});

test("upsertMcpServer preserves foreign top-level keys and other servers", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aitl-mcp-edit2-")), ".mcp.json");
  writeFileSync(
    path,
    JSON.stringify({ $schema: "x", mcpServers: { other: { command: "keep" } } }),
    "utf-8",
  );
  upsertMcpServer(path, "db", { command: "node", args: [], env: { A: "1" } });
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(raw.$schema, "x", "unknown keys survive the edit");
  assert.equal(raw.mcpServers.other.command, "keep");
  assert.deepEqual(raw.mcpServers.db, { command: "node", env: { A: "1" } });
});

test("removeMcpServer removes and reports; missing entries/files are false", () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-mcp-edit3-"));
  const path = join(dir, ".mcp.json");
  assert.equal(removeMcpServer(path, "db"), false);
  upsertMcpServer(path, "db", { command: "node", args: [], env: {} });
  assert.equal(removeMcpServer(path, "nope"), false);
  assert.equal(removeMcpServer(path, "db"), true);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(raw.mcpServers, {});
});
