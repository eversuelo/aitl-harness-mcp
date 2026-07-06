/**
 * Best-effort git context helpers. Never throw: outside a repo (or without git)
 * they return null, so callers can attach branch provenance without a hard dependency.
 */

import { execFileSync } from "node:child_process";

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Current branch name for `cwd` (or null if not a git repo / detached / git missing). */
export function currentBranch(cwd: string = process.cwd()): string | null {
  const out = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return out && out !== "HEAD" ? out : null;
}

/** Local branch names (empty if not a git repo / git missing). */
export function listLocalBranches(cwd: string = process.cwd()): string[] {
  const out = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/** Head SHA of a branch (short), or null. */
export function branchHeadSha(name: string, cwd: string = process.cwd()): string | null {
  return git(["rev-parse", "--short", name], cwd);
}

/** Full SHA of HEAD for `cwd` (or null outside a repo / before the first commit / git missing). */
export function headSha(cwd: string = process.cwd()): string | null {
  return git(["rev-parse", "HEAD"], cwd);
}

/** Resolve any git ref (branch, tag, sha, HEAD~2, …) to its full SHA, or null if unknown. */
export function resolveRef(ref: string, cwd: string = process.cwd()): string | null {
  return git(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
}

/** Commits `branch` has that `base` does not (`base..branch`), or null on error. */
export function aheadCount(base: string, branch: string, cwd: string = process.cwd()): number | null {
  const out = git(["rev-list", "--count", `${base}..${branch}`], cwd);
  if (out == null) return null;
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect the trunk `branch` most likely forked from: the candidate trunk with the
 * fewest commits between it and `branch` (closest fork point). Returns null if no
 * candidate applies. Used to draw GitHub-style derivation edges.
 */
export function detectBaseBranch(branch: string, candidates: string[], cwd: string = process.cwd()): string | null {
  let best: { name: string; ahead: number } | null = null;
  for (const c of candidates) {
    if (c === branch) continue;
    const ahead = aheadCount(c, branch, cwd);
    if (ahead == null) continue;
    if (!best || ahead < best.ahead) best = { name: c, ahead };
  }
  return best?.name ?? null;
}
