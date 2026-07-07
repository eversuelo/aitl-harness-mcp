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

export class RepoMap {
  // Retained for call-site compatibility (`new RepoMap(store.db)`); the symbols
  // collection is now accessed through the Mongoose `SymbolModel`, not this handle.
  private db?: Db;

  constructor(db?: Db) {
    this.db = db;
  }

  /**
   * Parse the tree, rank symbols, upsert into Mongo. Returns symbol count.
   * When `repo` is given, symbols are tagged with it and only that repo's symbols
   * are replaced (rebuilding one repo does not wipe the project's other repos).
   */
  async build(root: string, project: string, repo: string | null = null): Promise<number> {
    await ensureMongoose();
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

    await SymbolModel.deleteMany(repo ? { project, repo } : { project, repo: null });
    const docs = await Promise.all(files.flatMap((fsym) =>
      fsym.defs.map(([name, kind]) =>
        makeSymbol({
          project,
          repo,
          branch,
          file: fsym.file,
          name,
          kind,
          refs: [...fsym.refs].slice(0, 50),
          pagerank: scores.get(`${fsym.file}${String.fromCharCode(1)}${name}`) ?? 0,
          mtime: mtimes.get(fsym.file) ?? 0,
        }),
      ),
    ));
    if (docs.length) await SymbolModel.insertMany(docs);
    return docs.length;
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
