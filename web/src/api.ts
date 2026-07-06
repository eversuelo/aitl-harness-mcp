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
  /** Lifecycle (F4): why it was deprecated, its replacement and its soft-TTL review date. */
  deprecation_reason?: string | null;
  superseded_by?: string | null;
  review_after?: string | null;
  components?: string[];
  created_at?: string;
}

export interface PromptDoc {
  project: string;
  prompt: string;
  title?: string;
  source?: string;
  tags?: string[];
  model?: string | null;
  run_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface RunDoc {
  _id: string;
  project: string;
  model: string;
  status: "running" | "done" | "error";
  token_usage?: { input: number; output: number };
  iters?: number | null;
  tool_calls?: number | null;
  gate_denials?: number | null;
  roles?: string[];
  spec?: boolean;
  decision_blocked?: boolean;
  host_meta?: Record<string, unknown> | null;
  started_at?: string;
  ended_at?: string | null;
  harness_config?: Record<string, unknown>;
}

export interface RunDetail {
  run: RunDoc;
  event_counts: Record<string, number>;
  intervention_minutes: number;
}

export type NodeKind = "symbol" | "memory" | "decision" | "context" | "software" | "project" | "repo" | "branch" | "run" | "prompt";
export type EdgeKind = "ref" | "link" | "contains" | "references" | "derives" | "produced";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  project: string;
  file?: string;
  pagerank?: number;
  category?: string | null;
  title?: string;
  status?: string;
  [k: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeKind;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const KNOWLEDGE_KINDS: NodeKind[] = ["software", "project", "repo", "branch", "memory", "decision", "context", "symbol"];

/** Thrown on any 401 — the UI catches it to open the login dialog. */
export class UnauthorizedError extends Error {
  constructor(message = "login required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface Session {
  token: string;
  id: string;
  role: string;
  expires_at: string;
}

export interface Me {
  id: string;
  role: string;
  source?: string;
}

const TOKEN_KEY = "aitl.session";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — session lives for the page only */
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
}

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    setToken(null); // stale/invalid token — force a fresh login
    throw new UnauthorizedError(body.error ?? "login required");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: async (username: string, password: string): Promise<Session> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const session = await json<Session>(res);
    setToken(session.token);
    return session;
  },

  logout: async (): Promise<void> => {
    const token = getToken();
    setToken(null);
    if (token) {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  },

  me: () => fetch("/api/auth/me", { headers: authHeaders() }).then(json<Me>),

  config: () => fetch("/api/config", { headers: authHeaders() }).then(json<Record<string, string>>),
  projects: () => fetch("/api/projects", { headers: authHeaders() }).then(json<string[]>),

  list: (project: string) =>
    fetch(`/api/memory?project=${encodeURIComponent(project)}`, { headers: authHeaders() }).then(
      json<MemoryDoc[]>,
    ),

  search: (project: string, q: string) =>
    fetch(`/api/memory/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`, {
      headers: authHeaders(),
    }).then(json<MemoryDoc[]>),

  get: (project: string, slug: string) =>
    fetch(`/api/memory/${encodeURIComponent(slug)}?project=${encodeURIComponent(project)}`, {
      headers: authHeaders(),
    }).then(json<MemoryDoc>),

  save: (doc: MemoryInput) =>
    fetch("/api/memory", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(doc),
    }).then(json<{ slug: string; category: string | null; type: string }>),

  remove: (project: string, slug: string) =>
    fetch(`/api/memory/${encodeURIComponent(slug)}?project=${encodeURIComponent(project)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).then(json<{ deleted: boolean }>),

  decisions: (project: string) =>
    fetch(`/api/decisions?project=${encodeURIComponent(project)}`, { headers: authHeaders() }).then(
      json<DecisionDoc[]>,
    ),

  prompts: (project: string) =>
    fetch(`/api/prompts?project=${encodeURIComponent(project)}`, { headers: authHeaders() }).then(
      json<PromptDoc[]>,
    ),

  runs: (project: string) =>
    fetch(`/api/runs?project=${encodeURIComponent(project)}`, { headers: authHeaders() }).then(
      json<RunDoc[]>,
    ),

  run: (id: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}`, { headers: authHeaders() }).then(json<RunDetail>),

  sessionGraph: (project: string, id: string, temporal = false) =>
    fetch(
      `/api/runs/${encodeURIComponent(id)}/graph?project=${encodeURIComponent(project)}${temporal ? "&temporal=1" : ""}`,
      { headers: authHeaders() },
    ).then(json<GraphData>),

  graph: (project: string, scope: "all" | "symbols" | "memory" = "all") =>
    fetch(`/api/graph?project=${encodeURIComponent(project)}&scope=${scope}`, {
      headers: authHeaders(),
    }).then(json<GraphData>),

  knowledgeGraph: (project: string, entities?: NodeKind[]) =>
    fetch(
      `/api/knowledge-graph?project=${encodeURIComponent(project)}${entities ? `&entities=${entities.join(",")}` : ""}`,
      { headers: authHeaders() },
    ).then(json<GraphData>),
};
