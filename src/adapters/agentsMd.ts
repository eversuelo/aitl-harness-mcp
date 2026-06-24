/**
 * Canonical adapter: normalize/emit AGENTS.md (the cross-tool source of truth).
 * All other adapters derive from this. Order #1 in the incremental rollout.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { type Canon, type ToolAdapter, renderRules } from "./base.js";

export class AgentsMdAdapter implements ToolAdapter {
  readonly name = "agents_md";

  async export(canon: Canon, repoRoot: string): Promise<string[]> {
    const out = join(repoRoot, "AGENTS.md");
    // If AGENTS.md already exists we keep it as the canon; otherwise synthesize one
    // from the stored conventions + decisions.
    if (canon.agentsMd.trim()) return [out];
    const body = ["# AGENTS.md", "", "## Conventions", renderRules(canon), ""];
    if (canon.decisions.length) {
      body.push("## Key decisions");
      for (const d of canon.decisions) body.push(`- ADR-${String(d.id)}: ${String(d.title)}`);
    }
    await fs.writeFile(out, body.join("\n") + "\n", "utf-8");
    return [out];
  }
}
