/**
 * Best-effort git context helpers. Never throw: outside a repo (or without git)
 * they return null, so callers can attach branch provenance without a hard dependency.
 */

import { execFileSync } from "node:child_process";

/** Current branch name for `cwd` (or null if not a git repo / detached / git missing). */
export function currentBranch(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}
