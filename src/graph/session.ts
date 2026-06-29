/**
 * Per-session graph (ADR-0035) — link ONE run to the durable artifacts written during its
 * session: the ADRs, memories and prompts it produced.
 *
 * The reliable, retroactive linkage comes from the run's `artifacts` (the MCP
 * `record_decision`/`write_memory`/`record_prompt` calls parsed out of the Claude Code
 * transcript by `capture-session`), plus prompts whose `run_id` matches and memories
 * tagged for the run (`run:<id8>`, `session-<id8>`, `spec-synthesis-<id8>`). A `temporal`
 * fallback (docs created within the run's wall-clock span) is opt-in to avoid noise.
 *
 * Split into a pure assembler (`assembleSessionGraph`, no I/O — unit-testable) and a Mongo
 * fetcher (`sessionGraph`) that resolves which docs to include.
 */

import type { Db } from "mongodb";
import type { Graph, GraphEdge, GraphNode } from "./types.js";

/** How a doc came to be linked to the run, surfaced on the node for transparency. */
export type LinkBasis = "artifact" | "run_id" | "tag" | "temporal";

export interface LinkedDoc {
  id: string; // ADR id, memory slug, or a synthetic prompt id
  label: string;
  basis: LinkBasis;
  extra?: Record<string, unknown>;
}

export interface SessionRunInfo {
  runId: string;
  project: string;
  model?: string;
  status?: string;
  tokensTotal?: number;
  spec?: boolean;
}

export interface SessionLinks {
  decisions: LinkedDoc[];
  memories: LinkedDoc[];
  prompts: LinkedDoc[];
}

/** Pure: assemble a run node + its produced-artifact nodes/edges into a Graph. */
export function assembleSessionGraph(run: SessionRunInfo, links: SessionLinks): Graph {
  const runNodeId = `run:${run.runId}`;
  const nodes: GraphNode[] = [
    {
      id: runNodeId,
      kind: "run",
      project: run.project,
      label: `${run.model ?? "run"} · ${(run.tokensTotal ?? 0).toLocaleString("en-US")} tok`,
      run_id: run.runId,
      status: run.status ?? null,
      spec: run.spec ?? false,
    },
  ];
  const edges: GraphEdge[] = [];

  const add = (d: LinkedDoc, kind: GraphNode["kind"], prefix: string): void => {
    const nid = `${prefix}:${d.id}`;
    nodes.push({ id: nid, kind, project: run.project, label: d.label, basis: d.basis, ...(d.extra ?? {}) });
    edges.push({ source: runNodeId, target: nid, type: "produced" });
  };

  for (const d of links.decisions) add(d, "decision", "decision");
  for (const d of links.memories) add(d, "memory", "memory");
  for (const d of links.prompts) add(d, "prompt", "prompt");

  // Preserve memory↔memory [[links]] among the linked memories (reuses the `link` edge).
  const memIds = new Set(links.memories.map((m) => m.id));
  for (const m of links.memories) {
    const wikiLinks = (m.extra?.links as string[] | undefined) ?? [];
    for (const target of wikiLinks) {
      if (memIds.has(target)) edges.push({ source: `memory:${m.id}`, target: `memory:${target}`, type: "link" });
    }
  }

  return { nodes, edges };
}

const idShort = (runId: string) => runId.slice(0, 8);

/** Resolve and assemble the per-session graph from Mongo. `temporal` opts into the time-window fallback. */
export async function sessionGraph(
  db: Db,
  project: string,
  runId: string,
  opts: { temporal?: boolean } = {},
): Promise<Graph | null> {
  const run = await db.collection("runs").findOne({ _id: runId as never });
  if (!run) return null;

  const artifacts = (run.artifacts ?? {}) as { decisions?: string[]; memories?: string[]; prompts?: string[] };
  const tu = (run.token_usage ?? {}) as { input?: number; output?: number };
  const started = run.started_at ? new Date(run.started_at as string) : null;
  const ended = run.ended_at ? new Date(run.ended_at as string) : null;
  const within = (d: unknown): boolean => {
    if (!opts.temporal || !started || !ended) return false;
    const t = d ? new Date(d as string) : null;
    return !!t && !Number.isNaN(t.getTime()) && t >= started && t <= ended;
  };

  // ── decisions: artifacts (by id) + optional temporal window ──────────────
  const decById = new Map<string, LinkedDoc>();
  const decRows = await db
    .collection("decisions")
    .find({ project }, { projection: { embedding: 0 } })
    .toArray();
  const artDec = new Set(artifacts.decisions ?? []);
  for (const r of decRows) {
    const id = String(r.id ?? "");
    if (!id) continue;
    const basis: LinkBasis | null = artDec.has(id) ? "artifact" : within(r.created_at) ? "temporal" : null;
    if (basis) decById.set(id, { id, label: `ADR-${id} ${String(r.title ?? "")}`.trim(), basis, extra: { status: r.status, title: r.title } });
  }

  // ── memories: artifacts (by slug) + run tags + optional temporal ─────────
  const memBySlug = new Map<string, LinkedDoc>();
  const artMem = new Set(artifacts.memories ?? []);
  const runTags = new Set([`run:${idShort(runId)}`]);
  const runSlugs = new Set([`session-${idShort(runId)}`, `spec-synthesis-${idShort(runId)}`]);
  const memRows = await db
    .collection("memory")
    .find({ project }, { projection: { embedding: 0 } })
    .toArray();
  for (const r of memRows) {
    const slug = String(r.slug ?? "");
    if (!slug) continue;
    const tags = (r.tags as string[] | undefined) ?? [];
    const basis: LinkBasis | null = artMem.has(slug)
      ? "artifact"
      : runSlugs.has(slug) || tags.some((t) => runTags.has(t))
        ? "tag"
        : within(r.created_at)
          ? "temporal"
          : null;
    if (basis)
      memBySlug.set(slug, {
        id: slug,
        label: slug,
        basis,
        extra: { category: r.category ?? null, type: r.type ?? null, links: (r.links as string[]) ?? [] },
      });
  }

  // ── prompts: linked by run_id (+ optional temporal) ──────────────────────
  const prompts: LinkedDoc[] = [];
  const promptRows = await db
    .collection("prompts")
    .find({ project, $or: [{ run_id: runId }, ...(opts.temporal ? [{ run_id: { $in: [null] } }] : [])] })
    .sort({ created_at: 1 })
    .limit(100)
    .toArray();
  promptRows.forEach((r, i) => {
    const isRun = r.run_id === runId;
    if (!isRun && !within(r.created_at)) return;
    const tags = (r.tags as string[] | undefined) ?? [];
    const label = String(r.title || String(r.prompt ?? "").replace(/\s+/g, " ").slice(0, 48) || `prompt ${i + 1}`);
    prompts.push({ id: String(r._id ?? i), label, basis: isRun ? "run_id" : "temporal", extra: { spec: tags.includes("spec"), tags } });
  });

  return assembleSessionGraph(
    {
      runId,
      project,
      model: String(run.model ?? ""),
      status: String(run.status ?? ""),
      tokensTotal: (tu.input ?? 0) + (tu.output ?? 0),
      spec: Boolean(run.spec),
    },
    { decisions: [...decById.values()], memories: [...memBySlug.values()], prompts },
  );
}
