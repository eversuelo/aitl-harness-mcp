/**
 * Build, cache and render the repo map.
 *
 * The map is cached in the `symbols` collection keyed by (project, file) with the
 * file's mtime, so unchanged files are not re-parsed. `render()` returns a compact,
 * token-budgeted view suitable to expose to the agent as a tool.
 */

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import type { Db } from "mongodb";
import { ensureMongoose } from "../db/mongoose.js";
import { SymbolModel, makeSymbol } from "../models/symbol.model.js";
import { currentBranch } from "../util/git.js";
import { parseTree } from "./parser.js";
import { rankSymbols, selectWithinBudget } from "./ranker.js";

/** Per-build write stats (repo map v2 F1): what changed in the `symbols` collection. */
export interface BuildStats {
  symbols: number; // total live symbols for (project, repo) after the build
  files_scanned: number;
  files_written: number; // files whose symbols were (re)written — new, changed mtime, or pre-v2 docs
  files_pruned: number; // files deleted from disk whose stale symbols were removed
}

export class RepoMap {
  // Retained for call-site compatibility (`new RepoMap(store.db)`); the symbols
  // collection is now accessed through the Mongoose `SymbolModel`, not this handle.
  private db?: Db;
  /** Stats of the most recent `build()` on this instance (callers keep the numeric return). */
  lastStats: BuildStats | null = null;

  constructor(db?: Db) {
    this.db = db;
  }

  /**
   * Parse the tree, rank symbols, write into Mongo incrementally. Returns symbol count.
   * When `repo` is given, symbols are tagged with it and only that repo's symbols
   * are touched (rebuilding one repo does not wipe the project's other repos).
   *
   * Incremental contract (v2, closes G6 of PLAN-REPOMAP-V2): the tree is always
   * parsed in full (the heuristic scanner is cheap and PageRank needs the whole
   * graph), but WRITES are per-file — symbols of deleted files are pruned, only
   * files with a changed mtime (or pre-v2 docs missing `line_start`) are rewritten,
   * and unchanged files just get their pagerank refreshed in bulk.
   */
  async build(root: string, project: string, repo: string | null = null, opts: { full?: boolean } = {}): Promise<number> {
    await ensureMongoose();
    const scope = repo ? { project, repo } : { project, repo: null };
    const files = await parseTree(root);
    // Relativize every path to `root` so stored keys are PORTABLE (e.g. `repomap/store.ts`,
    // not `/abs/.../src/repomap/store.ts`). The ranker treats `file` as an opaque key, so
    // relativizing before ranking keeps its keys consistent.
    for (const f of files) f.file = relative(root, f.file);
    const scores = rankSymbols(files);
    const branch = currentBranch(root); // stamp which branch this snapshot is for

    const mtimes = new Map<string, number>();
    for (const fsym of files) {
      try {
        // `fsym.file` is now root-relative; resolve against `root` for the stat.
        mtimes.set(fsym.file, (await fs.stat(join(root, fsym.file))).mtimeMs / 1000);
      } catch {
        mtimes.set(fsym.file, 0);
      }
    }

    // Snapshot what the store already holds for this scope: per-file mtime + whether
    // the docs are v2-rich (line_start present) — pre-v2 docs must be rewritten once.
    const existing = (await SymbolModel.find(scope, { file: 1, mtime: 1, line_start: 1 }).lean()) as {
      file: string; mtime?: number; line_start?: number;
    }[];
    const storedByFile = new Map<string, { mtime: number; rich: boolean }>();
    for (const e of existing) {
      const prev = storedByFile.get(e.file);
      storedByFile.set(e.file, {
        mtime: e.mtime ?? 0,
        rich: (prev?.rich ?? true) && e.line_start !== undefined && e.line_start !== 0,
      });
    }

    // Prune: symbols of files that no longer exist on disk (or left the walk).
    const live = new Set(files.map((f) => f.file));
    const pruned = [...storedByFile.keys()].filter((f) => !live.has(f));
    if (pruned.length) await SymbolModel.deleteMany({ ...scope, file: { $in: pruned } });

    const changed = files.filter((f) => {
      if (opts.full) return true; // schema/extractor evolved → rewrite everything
      const stored = storedByFile.get(f.file);
      return !stored || stored.mtime !== (mtimes.get(f.file) ?? 0) || !stored.rich;
    });
    const unchanged = files.filter((f) => !changed.includes(f));

    if (changed.length) {
      await SymbolModel.deleteMany({ ...scope, file: { $in: changed.map((f) => f.file) } });
    }
    const docs = await Promise.all(changed.flatMap((fsym) =>
      fsym.defs.map((def) =>
        makeSymbol({
          project,
          repo,
          branch,
          file: fsym.file,
          name: def.name,
          kind: def.kind,
          line_start: def.line_start,
          line_end: def.line_end,
          parent: def.parent,
          exported: def.exported,
          signature: def.signature,
          doc: def.doc,
          refs: [...fsym.refs].slice(0, 50),
          pagerank: scores.get(`${fsym.file}${String.fromCharCode(1)}${def.name}`) ?? 0,
          mtime: mtimes.get(fsym.file) ?? 0,
        }),
      ),
    ));
    if (docs.length) await SymbolModel.insertMany(docs);

    // PageRank is global: any change shifts every score, so refresh the kept files too.
    const rankOps = unchanged.flatMap((fsym) =>
      fsym.defs.map((def) => ({
        updateOne: {
          filter: { ...scope, file: fsym.file, name: def.name },
          update: {
            $set: {
              pagerank: scores.get(`${fsym.file}${String.fromCharCode(1)}${def.name}`) ?? 0,
              branch,
              updated_at: new Date(),
            },
          },
        },
      })),
    );
    if (rankOps.length) await SymbolModel.bulkWrite(rankOps, { ordered: false });

    const total = docs.length + unchanged.reduce((s, f) => s + f.defs.length, 0);
    this.lastStats = {
      symbols: total,
      files_scanned: files.length,
      files_written: changed.length,
      files_pruned: pruned.length,
    };
    return total;
  }

  /** Render the top-ranked symbols within a token budget (agent-facing). Optional repo filter. */
  async render(project: string, opts: { maxTokens?: number; repo?: string } = {}): Promise<string> {
    await ensureMongoose();
    const query: Record<string, unknown> = { project };
    if (opts.repo !== undefined) query.repo = opts.repo;
    const rows = await SymbolModel.find(query).lean();
    // Staleness check: the stored snapshot is for one branch. If the working tree has since
    // moved to a different branch, the map may be wrong. Warn (do NOT auto-rebuild).
    const storedBranch = (rows[0] as { branch?: string | null } | undefined)?.branch ?? null;
    const liveBranch = currentBranch();
    if (rows.length && storedBranch !== liveBranch) {
      console.error(
        `[repomap] stale: symbols are for branch ${storedBranch}, current is ${liveBranch} — run 'aitl index-repo'`,
      );
    }
    const scores = new Map<string, number>();
    for (const r of rows) {
      scores.set(`${r.file}${String.fromCharCode(1)}${r.name}`, (r.pagerank as number) ?? 0);
    }
    const chosen = selectWithinBudget(scores, opts.maxTokens ?? 1024);
    const byFile = new Map<string, string[]>();
    for (const [file, name] of chosen) {
      (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(name);
    }
    const lines: string[] = [];
    for (const [file, names] of [...byFile.entries()].sort()) {
      lines.push(`${file}:`);
      for (const n of names) lines.push(`  - ${n}`);
    }
    return lines.join("\n") || "(repo map empty — run RepoMap.build first)";
  }
}
