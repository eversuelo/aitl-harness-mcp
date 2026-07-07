/**
 * Merge→reindex (P3/F2). `aitl branch sync` already stores each branch's `head_sha`;
 * this module compares the STORED head of the repo's base trunk (main/master) with the
 * live one and, when the base advanced (e.g. a merge landed), re-runs the master
 * indexer (`indexRepo`) so the repo map / memory / ADR mirror track the merged base.
 * The stored head is refreshed by the sync itself.
 *
 * Invoked by `aitl branch sync --reindex`; the git post-merge hook that calls it
 * automatically will be installed in P5.
 */

import { indexRepo, type IndexRepoResult } from "../indexing/indexRepo.js";
import type { BranchRecord } from "../models/branch.model.js";
import { branchHeadSha, listLocalBranches } from "../util/git.js";
import { BranchStore } from "./store.js";
import { type SyncBranchesOpts, syncBranches } from "./sync.js";

/** Preferred base trunks, most authoritative first (the merge target we track). */
const BASE_PRIORITY = ["main", "master", "develop", "dev"] as const;

/** Pick the repo's base trunk among its local branch names (main > master > develop > dev). */
export function detectBaseTrunk(names: string[]): string | null {
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const cand of BASE_PRIORITY) {
    const hit = lower.get(cand);
    if (hit) return hit;
  }
  return null;
}

export interface ReindexReport {
  /** The base trunk tracked (null when the repo has none). */
  base: string | null;
  /** Head recorded in the catalog before this sync (null on the first run). */
  storedSha: string | null;
  /** Live head of the base trunk. */
  liveSha: string | null;
  /** True when the base advanced (or was never recorded) and a reindex ran. */
  changed: boolean;
  result: IndexRepoResult | null;
}

export interface SyncWithReindexOpts extends SyncBranchesOpts {
  /** Compare the base trunk's stored vs live head and reindex when it advanced. */
  reindex?: boolean;
  /** Root handed to the master indexer (defaults to the git `root`). */
  indexRoot?: string;
}

/**
 * Sync the branch catalog and, with `reindex:true`, trigger the master indexer when
 * the base trunk's head moved since the last recorded sync. Returns the synced
 * records plus a report of the reindex decision (null when `reindex` is off).
 */
export async function syncBranchesWithReindex(
  opts: SyncWithReindexOpts,
): Promise<{ records: BranchRecord[]; reindex: ReindexReport | null }> {
  if (!opts.reindex) return { records: await syncBranches(opts), reindex: null };

  const base = detectBaseTrunk(listLocalBranches(opts.root));
  // Read the stored head BEFORE syncing — the sync refreshes it to the live sha.
  const stored = base ? await new BranchStore().get(opts.project, opts.repo, base) : null;
  const storedSha = stored?.head_sha ?? null;

  const records = await syncBranches(opts);
  const liveSha = base ? branchHeadSha(base, opts.root) : null;

  const changed = base !== null && liveSha !== null && storedSha !== liveSha;
  const result = changed
    ? await indexRepo({ project: opts.project, root: opts.indexRoot ?? opts.root, repo: opts.repo })
    : null;

  return { records, reindex: { base, storedSha, liveSha, changed, result } };
}
