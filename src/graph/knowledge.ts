/**
 * Knowledge-map builder (ADR-0029). A single per-project graph spanning the whole
 * hierarchy: software → project → repo → {memory, decision, symbol, context}, plus
 * the existing `link`/`ref` edges and `references` cross-links parsed from [[...]].
 *
 * Pure: data in (rows), graph out. The Mongo wiring stays behind `GraphSource`.
 */

import { buildMemoryGraph, buildSymbolGraph } from "./build.js";
import type {
  ContextRow,
  DecisionRow,
  Graph,
  GraphEdge,
  GraphNode,
  MemoryRow,
  NodeKind,
  RepoRow,
  SoftwareRow,
  SymbolRow,
} from "./types.js";

export const KNOWLEDGE_ENTITIES: NodeKind[] = ["software", "project", "repo", "memory", "decision", "context", "symbol"];

export interface KnowledgeData {
  symbols: SymbolRow[];
  memory: MemoryRow[];
  decisions: DecisionRow[];
  context: ContextRow[];
  softwares: SoftwareRow[];
  repos: RepoRow[];
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;

/** Extract `[[targets]]` from a blob of text. */
function wikilinks(...texts: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(WIKILINK)) out.push(m[1].trim());
  }
  return out;
}

/**
 * Build the knowledge map for ONE project. `include` selects which entity kinds
 * appear (default: all). Hierarchy `contains` edges follow repo sub-scope: an item
 * with a `repo` attaches to that repo node; otherwise to the project node.
 */
export function buildKnowledgeGraph(
  data: KnowledgeData,
  project: string,
  include: NodeKind[] = KNOWLEDGE_ENTITIES,
): Graph {
  const want = new Set(include);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const ids = new Set<string>();
  const add = (n: GraphNode) => {
    if (!ids.has(n.id)) {
      ids.add(n.id);
      nodes.push(n);
    }
  };
  const edge = (source: string, target: string, type: GraphEdge["type"]) => {
    if (ids.has(source) && ids.has(target)) edges.push({ source, target, type });
  };

  const projId = `proj:${project}`;
  add({ id: projId, label: project, kind: "project", project });

  // Repos → attach point map (repo name → node id).
  const repoNode = new Map<string, string>();
  if (want.has("repo")) {
    for (const r of data.repos) {
      if (!r.name) continue;
      const id = `repo:${project}/${r.name}`;
      add({ id, label: r.name, kind: "repo", project, software: r.software ?? null });
      repoNode.set(r.name, id);
      edge(projId, id, "contains");
    }
  }

  // Softwares above the project.
  if (want.has("software")) {
    for (const s of data.softwares) {
      if (!s.name) continue;
      const id = `sw:${s.name}`;
      add({ id, label: s.display_name || s.name, kind: "software", project });
      edge(id, projId, "contains");
    }
  }

  // attach(): hierarchy parent for an item given its repo sub-scope.
  const attach = (childId: string, repo: string | null | undefined) => {
    const parent = repo && repoNode.has(repo) ? repoNode.get(repo)! : projId;
    edge(parent, childId, "contains");
  };

  // Memory (reuse existing builder for nodes + link edges).
  if (want.has("memory")) {
    const mg = buildMemoryGraph(data.memory, project);
    for (const n of mg.nodes) add(n);
    edges.push(...mg.edges);
    const repoBySlug = new Map(data.memory.map((m) => [m.slug, m.repo ?? null]));
    for (const m of data.memory) if (m.slug) attach(`mem:${m.slug}`, repoBySlug.get(m.slug));
  }

  // Decisions (ADRs).
  if (want.has("decision")) {
    for (const d of data.decisions) {
      if (!d.id) continue;
      const id = `adr:${project}:${d.id}`;
      add({ id, label: `ADR-${d.id}`, kind: "decision", project, title: d.title ?? "", status: d.status ?? "" });
      attach(id, d.repo);
    }
    // `references` cross-links: [[ADR-00xx]]/[[slug]] inside the ADR text.
    for (const d of data.decisions) {
      if (!d.id) continue;
      const src = `adr:${project}:${d.id}`;
      for (const link of wikilinks(d.context, d.decision, d.consequences)) {
        const adrId = link.replace(/^ADR-?/i, "").padStart(4, "0");
        const adrTarget = `adr:${project}:${adrId}`;
        const memTarget = `mem:${link}`;
        if (ids.has(adrTarget) && adrTarget !== src) edge(src, adrTarget, "references");
        else if (ids.has(memTarget)) edge(src, memTarget, "references");
      }
    }
  }

  // Context snapshots.
  if (want.has("context")) {
    for (const c of data.context) {
      if (!c.context_id) continue;
      const id = `ctx:${c.context_id}`;
      add({ id, label: c.title || c.context_id.slice(0, 8), kind: "context", project, run_id: c.run_id ?? null });
      attach(id, c.repo);
    }
  }

  // Symbols (optional; can be large — off unless requested).
  if (want.has("symbol")) {
    const sg = buildSymbolGraph(data.symbols, project);
    for (const n of sg.nodes) add(n);
    edges.push(...sg.edges);
    const repoByFile = new Map(data.symbols.map((s) => [s.file, s.repo ?? null]));
    for (const s of data.symbols) attach(`sym:${s.file}::${s.name}`, repoByFile.get(s.file) as string | null | undefined);
  }

  return { nodes, edges };
}
