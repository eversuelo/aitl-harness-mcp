/** Typed client for the memory-admin HTTP API (proxied at /api by Vite). */

export interface MemoryDoc {
  project: string;
  slug: string;
  type: string;
  description: string;
  body: string;
  category: string | null;
  tags: string[];
  links: string[];
  created_at?: string;
  updated_at?: string;
  score?: number;
}

export interface MemoryInput {
  project: string;
  slug: string;
  type: string;
  description: string;
  body: string;
  tags: string[];
}

export interface DecisionDoc {
  project: string;
  id: string;
  title: string;
  status: string;
  context: string;
  decision: string;
  consequences: string;
  created_at?: string;
}

export interface PromptDoc {
  project: string;
  prompt: string;
  title?: string;
  source?: string;
  tags?: string[];
  created_at?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "symbol" | "memory";
  project: string;
  file?: string;
  pagerank?: number;
  category?: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "ref" | "link";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => fetch("/api/config").then(json<Record<string, string>>),
  projects: () => fetch("/api/projects").then(json<string[]>),

  list: (project: string) =>
    fetch(`/api/memory?project=${encodeURIComponent(project)}`).then(json<MemoryDoc[]>),

  search: (project: string, q: string) =>
    fetch(`/api/memory/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`).then(
      json<MemoryDoc[]>,
    ),

  get: (project: string, slug: string) =>
    fetch(`/api/memory/${encodeURIComponent(slug)}?project=${encodeURIComponent(project)}`).then(
      json<MemoryDoc>,
    ),

  save: (doc: MemoryInput) =>
    fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    }).then(json<{ slug: string; category: string | null; type: string }>),

  remove: (project: string, slug: string) =>
    fetch(`/api/memory/${encodeURIComponent(slug)}?project=${encodeURIComponent(project)}`, {
      method: "DELETE",
    }).then(json<{ deleted: boolean }>),

  decisions: (project: string) =>
    fetch(`/api/decisions?project=${encodeURIComponent(project)}`).then(json<DecisionDoc[]>),

  prompts: (project: string) =>
    fetch(`/api/prompts?project=${encodeURIComponent(project)}`).then(json<PromptDoc[]>),

  graph: (project: string, scope: "all" | "symbols" | "memory" = "all") =>
    fetch(`/api/graph?project=${encodeURIComponent(project)}&scope=${scope}`).then(json<GraphData>),
};
