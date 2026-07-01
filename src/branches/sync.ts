/**
 * Branch sync (ADR-0031). Read the local git branches of a repo root, classify each
 * (kind + environment), detect its derivation parent (git fork-point, falling back to
 * the gitflow convention), and upsert into the `branches` collection.
 */

import { branchHeadSha, detectBaseBranch, listLocalBranches } from "../util/git.js";
import { classifyBranch } from "../util/branches.js";
import { BranchStore } from "./store.js";
import type { BranchRecord } from "../models/branch.model.js";

const TRUNK_NAMES = new Set(["main", "master", "develop", "dev", "staging", "stage", "qa"]);

export interface SyncBranchesOpts {
  project: string;
  repo: string;
  root: string;
  remote?: string | null;
}

/** Sync the branches of a git repo into the catalog. Returns the stored records. */
export async function syncBranches(opts: SyncBranchesOpts): Promise<BranchRecord[]> {
  const names = listLocalBranches(opts.root);
  if (!names.length) return [];

  // Trunks that actually exist (used both for classification hints and base detection).
  const trunks = names.filter((n) => TRUNK_NAMES.has(n.toLowerCase()));
  const store = new BranchStore();
  const out: BranchRecord[] = [];

  for (const name of names) {
    const cls = classifyBranch(name, trunks);
    // Trunks derive from nothing; others prefer the git-detected fork point, then the
    // conventional base from the classifier.
    const base = cls.protected && cls.derivesFrom === null
      ? null
      : detectBaseBranch(name, trunks, opts.root) ?? cls.derivesFrom;
    out.push(
      await store.upsert({
        project: opts.project,
        repo: opts.repo,
        name,
        kind: cls.kind,
        environment: cls.environment,
        base,
        protectedBranch: cls.protected,
        head_sha: branchHeadSha(name, opts.root),
        remote: opts.remote ?? null,
      }),
    );
  }
  return out;
}
