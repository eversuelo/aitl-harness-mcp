import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESOURCES } from "../auth/rbac.js";
import { TOOL_RBAC } from "./server.js";

/**
 * Contract: EVERY MCP tool that mutates durable state must be RBAC-mapped in
 * TOOL_RBAC (read-only tools are absent by design). This canary pins the full
 * mutating set so a new write-tool without a mapping fails loudly here.
 */
const MUTATING_TOOLS = [
  "write_memory",
  "update_memory",
  "delete_memory",
  "ingest_path",
  "graphify",
  "record_decision",
  "deprecate_decision",
  "record_prompt",
  "save_mcp_context",
  "record_human_intervention",
  "write_software",
  "delete_software",
  "write_repo",
  "delete_repo",
  "index_repo",
  "build_definition",
  "write_agent",
  "write_skill",
  "delete_agent",
  "delete_skill",
  "sync_branches",
  "delete_branch",
  "write_role",
  "seed_roles",
  "claim_task",
  "release_task",
  "publish_event",
  "run_agent",
  "synthesize",
] as const;

const READ_ONLY_SAMPLE = [
  "search_memory",
  "get_memory",
  "list_decisions",
  "get_skill",
  "list_agents",
  "get_repomap",
  "poll_events",
  "coord_status",
  "list_decision_versions",
  "get_memory_version",
] as const;

describe("TOOL_RBAC — cobertura", () => {
  it("todas las tools mutantes están mapeadas", () => {
    for (const tool of MUTATING_TOOLS) {
      assert.ok(TOOL_RBAC[tool], `tool mutante sin RBAC: ${tool}`);
    }
  });

  it("no hay entradas fuera del set mutante (biyección con el contrato)", () => {
    assert.deepEqual(Object.keys(TOOL_RBAC).sort(), [...MUTATING_TOOLS].sort());
  });

  it("las tools de solo lectura NO están gateadas", () => {
    for (const tool of READ_ONLY_SAMPLE) {
      assert.equal(TOOL_RBAC[tool], undefined, `read-only gateada por error: ${tool}`);
    }
  });
});

describe("TOOL_RBAC — forma de las entradas", () => {
  it("cada entrada usa un Resource del catálogo y una Action válida", () => {
    const actions = new Set(["create", "read", "update", "delete", "set_role", "disable", "execute"]);
    for (const [tool, need] of Object.entries(TOOL_RBAC)) {
      assert.ok((RESOURCES as readonly string[]).includes(need.resource), `${tool}: resource desconocido ${need.resource}`);
      assert.ok(actions.has(need.action), `${tool}: action desconocida ${need.action}`);
    }
  });

  it("las definition-tools templadas comparten el mapping de build_definition", () => {
    assert.deepEqual(TOOL_RBAC.write_agent, { resource: "agents_skills", action: "create" });
    assert.deepEqual(TOOL_RBAC.write_skill, { resource: "agents_skills", action: "create" });
    assert.deepEqual(TOOL_RBAC.delete_agent, { resource: "agents_skills", action: "delete" });
    assert.deepEqual(TOOL_RBAC.delete_skill, { resource: "agents_skills", action: "delete" });
    assert.deepEqual(TOOL_RBAC.build_definition, { resource: "agents_skills", action: "create" });
  });

  it("contexto de sesión y supervisión humana escriben estado durable (memory:create)", () => {
    assert.deepEqual(TOOL_RBAC.save_mcp_context, { resource: "memory", action: "create" });
    assert.deepEqual(TOOL_RBAC.record_human_intervention, { resource: "memory", action: "create" });
  });

  it("synthesize reescribe memoria y publish_event escribe coordinación", () => {
    assert.deepEqual(TOOL_RBAC.synthesize, { resource: "memory", action: "update" });
    assert.deepEqual(TOOL_RBAC.publish_event, { resource: "coordination", action: "create" });
  });

  it("edición y borrado de memoria mapean a memory:update / memory:delete", () => {
    assert.deepEqual(TOOL_RBAC.update_memory, { resource: "memory", action: "update" });
    assert.deepEqual(TOOL_RBAC.delete_memory, { resource: "memory", action: "delete" });
  });
});
