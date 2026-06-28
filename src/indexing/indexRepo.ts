/**
 * Master repo indexer (ADR-0030). One call that indexes "everything needed to
 * develop" a repo into the durable store: the repo map (symbols via tree-sitter +
 * PageRank), markdown memory, and ADRs. Each step is best-effort and independently
 * reported, so a missing source never aborts the others.
 *
 * Reused by the `aitl index-repo` CLI and the `index_repo` MCP tool.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ADRStore } from "../decisions/adr.js";
import { embedOne } from "../ingest/embedder.js";
import { parseMarkdownDir } from "../ingest/markdown.js";
import { Classifier } from "../memory/classifier.js";
import { MemoryStore } from "../memory/store.js";
import { RepoMap } from "../repomap/store.js";
import { currentBranch } from "../util/git.js";
import type { VersioningActor } from "../memory/versioning.js";

export interface IndexRepoOpts {
  project: string;
  root: string;
  repo?: string | null;
  /** Directory of markdown memory to ingest (default: skip). */
  memoryDir?: string;
  /** ADR directory to sync (default: <root>/docs/adr if it exists). */
  adrDir?: string;
  actor?: VersioningActor;
}

export interface IndexRepoResult {
  project: string;
  repo: string | null;
  branch: string | null;
  symbols: number;
  memory: number;
  adrs: number;
  steps: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Index a repo into the durable store: symbols + memory + ADRs. */
export async function indexRepo(opts: IndexRepoOpts): Promise<IndexRepoResult> {
  const repo = opts.repo ?? null;
  const branch = currentBranch(opts.root);
  const steps: string[] = [];
  const result: IndexRepoResult = { project: opts.project, repo, branch, symbols: 0, memory: 0, adrs: 0, steps };

  // 1. Repo map (symbols) — the core of "what's needed to develop".
  try {
    result.symbols = await new RepoMap().build(opts.root, opts.project, repo);
    steps.push(`repomap: ${result.symbols} symbols`);
  } catch (err) {
    steps.push(`repomap: failed (${err instanceof Error ? err.message : String(err)})`);
  }

  // 2. Markdown memory (optional).
  if (opts.memoryDir) {
    try {
      const store = new MemoryStore();
      const clf = new Classifier();
      const docs = await parseMarkdownDir(opts.memoryDir, opts.project);
      for (const doc of docs) {
        if (repo) doc.repo = repo;
        await clf.classifyMemory(doc);
        doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
        await store.upsertMemory(doc, { actor: opts.actor, branch });
      }
      result.memory = docs.length;
      steps.push(`memory: ${docs.length} docs`);
    } catch (err) {
      steps.push(`memory: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // 3. ADRs (default <root>/docs/adr if present).
  const adrDir = opts.adrDir ?? join(opts.root, "docs", "adr");
  if (await exists(adrDir)) {
    try {
      const ids = await new ADRStore().syncDir(adrDir, opts.project, { actor: opts.actor, branch });
      result.adrs = ids.length;
      steps.push(`adrs: ${ids.length} synced`);
    } catch (err) {
      steps.push(`adrs: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return result;
}
