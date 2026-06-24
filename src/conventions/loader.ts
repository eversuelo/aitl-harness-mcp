/**
 * Load project conventions from AGENTS.md (and glob-scoped rule files).
 *
 * Conventions are Pain Point #3: instead of hoping the model infers patterns, we make
 * them explicit, durable records that hooks can enforce as gates. AGENTS.md is the
 * canonical cross-tool source; the adapters layer projects it into other tools.
 */

import { promises as fs } from "node:fs";
import { getDb } from "../db/client.js";
import { type Convention, makeConvention } from "../memory/schemas.js";

export async function parseAgentsMd(path: string, project: string): Promise<Convention[]> {
  const text = await fs.readFile(path, "utf-8");
  const conventions: Convention[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("## ")) {
      inSection = stripped.toLowerCase().startsWith("## conventions");
      continue;
    }
    if (inSection && (stripped.startsWith("- ") || stripped.startsWith("* "))) {
      const rule = stripped.slice(2).trim();
      const severity = ["never", "must", "always"].some((w) => rule.toLowerCase().includes(w))
        ? "error"
        : "warn";
      conventions.push(makeConvention({ project, scope_glob: "**/*", rule, severity }));
    }
  }
  return conventions;
}

export async function loadConventions(
  path: string,
  project: string,
  opts: { persist?: boolean } = {},
): Promise<Convention[]> {
  const conventions = await parseAgentsMd(path, project);
  if (opts.persist !== false && conventions.length) {
    const db = getDb();
    await db.collection("conventions").deleteMany({ project });
    await db.collection("conventions").insertMany(conventions);
  }
  return conventions;
}
