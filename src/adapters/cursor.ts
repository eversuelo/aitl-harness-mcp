/** Cursor adapter: emit `.cursor/rules/*.mdc` from the canon. Rollout order #2. */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { type Canon, type ToolAdapter, renderRules } from "./base.js";

export class CursorAdapter implements ToolAdapter {
  readonly name = "cursor";

  async export(canon: Canon, repoRoot: string): Promise<string[]> {
    const rulesDir = join(repoRoot, ".cursor", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    const out = join(rulesDir, "aitl.mdc");
    // .mdc = frontmatter + markdown body. `alwaysApply: true` mirrors Kiro's
    // always-loaded steering, so conventions are not accidentally omitted.
    const content =
      "---\n" +
      "description: AITL-Harness project conventions (generated — do not edit).\n" +
      "globs: ['**/*']\n" +
      "alwaysApply: true\n" +
      "---\n\n" +
      "# Conventions\n\n" +
      `${renderRules(canon)}\n`;
    await fs.writeFile(out, content, "utf-8");
    return [out];
  }
}
