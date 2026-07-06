/**
 * Markdown adapter: one-shot Mongo → canonical markdown mirror (P4).
 *
 * Projects the durable entities into the split canonical layout:
 *   memory/skills/agents → <root>/.aitl/{memory,skills,agents}/<slug>.md
 *   ADRs                 → <root>/docs/adr/NNNN-slug.md
 *
 * Manifest-less by design (use `aitl sync` for bidirectional reconciliation):
 * `.aitl/` is a generated mirror and is overwritten freely; `docs/adr/` is
 * handwritten territory, so existing ADR files with different content are kept
 * (only missing ones are added).
 */

import { join } from "node:path";
import { exportAdrs, exportAgents, exportMemory, exportSkills } from "../sync/export.js";
import type { Canon, ToolAdapter } from "./base.js";

export class MarkdownAdapter implements ToolAdapter {
  readonly name = "markdown";

  async export(canon: Canon, repoRoot: string): Promise<string[]> {
    const dir = join(repoRoot, ".aitl");
    const adrDir = join(repoRoot, "docs", "adr");
    const results = [
      await exportMemory(canon.project, dir),
      await exportSkills(canon.project, dir),
      await exportAgents(canon.project, dir),
      await exportAdrs(canon.project, adrDir),
    ];
    for (const r of results) {
      for (const s of r.skipped) console.error(`[markdown] skipped ${s.path}: ${s.reason}`);
    }
    return results.flatMap((r) => r.written);
  }
}
