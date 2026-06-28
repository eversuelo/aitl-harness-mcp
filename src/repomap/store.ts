/**
 * Build, cache and render the repo map.
 *
 * The map is cached in the `symbols` collection keyed by (project, file) with the
 * file's mtime, so unchanged files are not re-parsed. `render()` returns a compact,
 * token-budgeted view suitable to expose to the agent as a tool.
 */

import { promises as fs } from "node:fs";
import type { Db } from "mongodb";
import { getDb } from "../db/client.js";
import { makeSymbol } from "../memory/schemas.js";
import { parseTree } from "./parser.js";
import { rankSymbols, selectWithinBudget } from "./ranker.js";

export class RepoMap {
  private db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /**
   * Parse the tree, rank symbols, upsert into Mongo. Returns symbol count.
   * When `repo` is given, symbols are tagged with it and only that repo's symbols
   * are replaced (rebuilding one repo does not wipe the project's other repos).
   */
  async build(root: string, project: string, repo: string | null = null): Promise<number> {
    const files = await parseTree(root);
    const scores = rankSymbols(files);

    const mtimes = new Map<string, number>();
    for (const fsym of files) {
      try {
        mtimes.set(fsym.file, (await fs.stat(fsym.file)).mtimeMs / 1000);
      } catch {
        mtimes.set(fsym.file, 0);
      }
    }

    await this.db.collection("symbols").deleteMany(repo ? { project, repo } : { project, repo: null });
    const docs = files.flatMap((fsym) =>
      fsym.defs.map(([name, kind]) =>
        makeSymbol({
          project,
          repo,
          file: fsym.file,
          name,
          kind,
          refs: [...fsym.refs].slice(0, 50),
          pagerank: scores.get(`${fsym.file}${String.fromCharCode(1)}${name}`) ?? 0,
          mtime: mtimes.get(fsym.file) ?? 0,
        }),
      ),
    );
    if (docs.length) await this.db.collection("symbols").insertMany(docs);
    return docs.length;
  }

  /** Render the top-ranked symbols within a token budget (agent-facing). Optional repo filter. */
  async render(project: string, opts: { maxTokens?: number; repo?: string } = {}): Promise<string> {
    const query: Record<string, unknown> = { project };
    if (opts.repo !== undefined) query.repo = opts.repo;
    const rows = await this.db.collection("symbols").find(query).toArray();
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
