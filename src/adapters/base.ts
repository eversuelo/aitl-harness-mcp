/**
 * ToolAdapter interface + registry + canonical-artifact loader.
 *
 * `export(canon, repoRoot)` writes the tool's native files from the canon. The canon
 * is: the conventions in Mongo (parsed from AGENTS.md), the ADRs, and the memory bank.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/client.js";

export interface Canon {
  project: string;
  conventions: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  agentsMd: string;
}

export async function loadCanon(project: string, repoRoot: string): Promise<Canon> {
  const db = getDb();
  const agentsPath = join(repoRoot, "AGENTS.md");
  let agentsMd = "";
  try {
    agentsMd = await fs.readFile(agentsPath, "utf-8");
  } catch {
    agentsMd = "";
  }
  return {
    project,
    conventions: await db.collection("conventions").find({ project }, { projection: { _id: 0 } }).toArray(),
    decisions: await db
      .collection("decisions")
      .find({ project }, { projection: { _id: 0, embedding: 0 } })
      .toArray(),
    agentsMd,
  };
}

export interface ToolAdapter {
  readonly name: string;
  /** Write native files for this tool. Return the paths written. */
  export(canon: Canon, repoRoot: string): Promise<string[]>;
}

/** Shared helper: render conventions as a markdown bullet list. */
export function renderRules(canon: Canon): string {
  if (!canon.conventions.length) return canon.agentsMd; // fall back to raw AGENTS.md
  return canon.conventions.map((c) => `- ${String(c.rule)}`).join("\n");
}

export const ADAPTERS = ["agents_md", "cursor", "copilot", "antigravity", "kiro", "trae"] as const;

export async function getAdapter(name: string): Promise<ToolAdapter> {
  switch (name) {
    case "agents_md":
      return new (await import("./agentsMd.js")).AgentsMdAdapter();
    case "cursor":
      return new (await import("./cursor.js")).CursorAdapter();
    case "copilot":
      return new (await import("./copilot.js")).CopilotAdapter();
    case "antigravity":
      return new (await import("./antigravity.js")).AntigravityAdapter();
    case "kiro":
      return new (await import("./kiro.js")).KiroAdapter();
    case "trae":
      return new (await import("./trae.js")).TraeAdapter();
    default:
      throw new Error(`Unknown adapter '${name}'. Known: ${ADAPTERS.join(", ")}`);
  }
}
