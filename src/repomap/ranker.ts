/**
 * Rank symbols by importance with a PageRank over the symbol graph.
 *
 * Aider's insight: build a graph where files/symbols are nodes and edges connect a
 * file to the symbols it references; run PageRank; the top symbols are the most
 * "central" to the codebase. We then select within a token budget.
 *
 * A compact, dependency-free PageRank is implemented here (mirrors networkx.pagerank
 * with alpha=0.85) so the repo map has no heavy graph-library dependency.
 */

import type { FileSymbols } from "./parser.js";

type Key = string; // serialized node id

// Non-printable separator so file paths (which may contain spaces) never collide.
const SEP = String.fromCharCode(1);

const defNode = (file: string, name: string): Key => `def${SEP}${file}${SEP}${name}`;
const fileNode = (file: string): Key => `file${SEP}${file}`;
const symKey = (file: string, name: string): string => `${file}${SEP}${name}`;

export function rankSymbols(files: FileSymbols[]): Map<string, number> {
  const nodes = new Set<Key>();
  const edges: [Key, Key][] = [];

  // Map symbol name -> defining file(s).
  const definers = new Map<string, string[]>();
  for (const fs of files) {
    for (const [name] of fs.defs) {
      (definers.get(name) ?? definers.set(name, []).get(name)!).push(fs.file);
      nodes.add(defNode(fs.file, name));
    }
  }

  // Edge: a file that references `name` -> the file(s) defining it.
  for (const fs of files) {
    for (const ref of fs.refs) {
      for (const targetFile of definers.get(ref) ?? []) {
        if (targetFile !== fs.file) {
          nodes.add(fileNode(fs.file));
          edges.push([fileNode(fs.file), defNode(targetFile, ref)]);
        }
      }
    }
  }

  if (nodes.size === 0) return new Map();
  const pr = edges.length ? pagerank([...nodes], edges, 0.85) : uniform([...nodes]);

  // Collapse to {(file, name): max score}, keyed by `<file><SEP><name>`.
  const scores = new Map<string, number>();
  for (const [node, score] of pr) {
    if (!node.startsWith(`def${SEP}`)) continue;
    const [, file, name] = node.split(SEP);
    const key = symKey(file, name);
    scores.set(key, Math.max(scores.get(key) ?? 0, score));
  }
  return scores;
}

function uniform(nodes: Key[]): Map<Key, number> {
  return new Map(nodes.map((n) => [n, 1.0]));
}

/** Power-iteration PageRank with damping `alpha`. */
function pagerank(nodes: Key[], edges: [Key, Key][], alpha: number, iters = 100, tol = 1e-6): Map<Key, number> {
  const n = nodes.length;
  const idx = new Map(nodes.map((node, i) => [node, i]));
  const outAdj: number[][] = Array.from({ length: n }, () => []);
  for (const [src, dst] of edges) {
    const si = idx.get(src);
    const di = idx.get(dst);
    if (si !== undefined && di !== undefined) outAdj[si].push(di);
  }

  let rank = new Array<number>(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Array<number>(n).fill((1 - alpha) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outAdj[i].length === 0) {
        dangling += rank[i];
      } else {
        const share = (alpha * rank[i]) / outAdj[i].length;
        for (const j of outAdj[i]) next[j] += share;
      }
    }
    // Redistribute dangling-node mass uniformly.
    const danglingShare = (alpha * dangling) / n;
    for (let i = 0; i < n; i++) next[i] += danglingShare;

    const delta = next.reduce((s, v, i) => s + Math.abs(v - rank[i]), 0);
    rank = next;
    if (delta < tol) break;
  }
  return new Map(nodes.map((node, i) => [node, rank[i]]));
}

/** Pick the highest-ranked symbols that fit a rough token budget (~6 tok/line). */
export function selectWithinBudget(
  scores: Map<string, number>,
  maxTokens = 1024,
): [string, string, number][] {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const out: [string, string, number][] = [];
  let used = 0;
  for (const [key, score] of ranked) {
    const cost = 6; // one rendered line per symbol
    if (used + cost > maxTokens) break;
    const [file, name] = key.split(SEP);
    out.push([file, name, score]);
    used += cost;
  }
  return out;
}
