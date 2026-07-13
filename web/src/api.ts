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

/* ── tool-calls telemetry (mcp_tool_calls aggregation) ────────────────────── */

export interface ToolSummaryRow {
  _id: { project: string | null; tool: string };
  calls: number;
  ok: number;
  failed: number;
  avgMs: number | null;
  lastTs: string;
  firstTs: string;
  /** What was asked for in the most recent call (redacted args). */
  lastArgsPreview: string | null;
  /** Proof of what actually came back from the most recent successful call. */
  lastResultPreview: string | null;
  lastErrorMessage: string | null;
}

export interface ToolTargetRow {
  _id: { project: string | null; tool: string; target: string };
  calls: number;
  ok: number;
  failed: number;
  lastTs: string;
  lastResultPreview: string | null;
}

export interface ToolCallsReport {
  summary: ToolSummaryRow[];
  targets: ToolTargetRow[];
}

/* ── catalog hierarchy: software → project → repo → branch (ADR-0028/0031) ── */

export interface SoftwareDoc {
  name: string;
  display_name?: string;
  description?: string;
  projects: string[];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface RepoDoc {
  project: string;
  name: string;
  software?: string | null;
  remote?: string;
  branch?: string;
  path?: string;
  description?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface BranchDoc {
  project: string;
  repo: string;
  name: string;
  kind: string;
  environment: string;
  base?: string | null;
  protectedBranch?: boolean;
  head_sha?: string | null;
  remote?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

/** MCP context snapshot header (messages/context bodies excluded by the API). */
export interface ContextDoc {
  context_id: string;
  project: string;
  title?: string;
  summary?: string;
  source?: string;
  model?: string | null;
  run_id?: string | null;
  tags?: string[];
  repo?: string | null;
  created_at?: string;
  updated_at?: string;
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
  /** Whether self-service signup is enabled on the server (AITL_WEB_ALLOW_SIGNUP). */
  signup?: boolean;
}

export interface ProviderStatusEntry {
  name: string;
  configured: boolean;
  model: string;
  via: string;
}

export interface ConfigStatus {
  /** Effective config profile with secrets masked. */
  profile: Record<string, string>;
  /** Which layer produced each key: env | profile | dotenv | file (ADR-0061). */
  sources?: Record<string, string>;
  providers: {
    providers: ProviderStatusEntry[];
    active: string | null;
    fallbacks: string[];
    aitl_api_key?: string;
  };
  signup_enabled: boolean;
  /** Named profiles overview (ADR-0061). */
  profiles?: { active: string | null; names: string[] };
  /** Keys whose on-disk value differs from the running process (restart applies them). */
  pending_restart?: string[];
  mongo?: { ok: boolean; db?: string };
}

/* ── First-boot setup + named profiles (ADR-0061) ─────────────────────────── */

export interface SetupStatus {
  setup_required: boolean;
  mongo: { ok: boolean; error?: string; db?: string };
  has_real_users: boolean | null;
  /** Whether THIS client reaches the API via loopback (setup surface requires it). */
  loopback: boolean;
}

export interface ProfileSummary {
  name: string;
  keys: string[];
  active: boolean;
}

export interface ProfilesInfo {
  active: string | null;
  profiles: ProfileSummary[];
}

export interface RestartResponse {
  restarting: boolean;
  /** True when `aitl ui --watch-restart` supervises the process (auto-respawn). */
  will_respawn: boolean;
}

export interface DbInitReport {
  collections: string[];
  vector: { ok: boolean; error?: string };
  bootstrap: { status: string; username?: string };
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

  register: async (username: string, email: string, password: string): Promise<Session> => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, email, password }),
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

  configStatus: () => fetch("/api/config/status", { headers: authHeaders() }).then(json<ConfigStatus>),

  updateConfig: (updates: Record<string, string | null>) =>
    fetch("/api/config", {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ updates }),
    }).then(json<Record<string, string>>),

  /* ── setup wizard (no auth; server restricts to loopback + setup mode) ──── */

  setupStatus: () => fetch("/api/setup/status").then(json<SetupStatus>),

  setupRoot: async (username: string, email: string, password: string): Promise<Session> => {
    const res = await fetch("/api/setup/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, email, password }),
    });
    const session = await json<Session>(res);
    setToken(session.token); // the wizard continues authenticated as this root
    return session;
  },

  setupTestConnection: (uri: string, db?: string) =>
    fetch("/api/setup/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri, db }),
    }).then(json<{ ok: boolean; error?: string; db?: string }>),

  setupConnection: (updates: Record<string, string | null>) =>
    fetch("/api/setup/connection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates }),
    }).then(json<{ keys: string[]; pending_restart: string[] }>),

  /* ── named profiles (root/admin via config_secrets) ─────────────────────── */

  profiles: () => fetch("/api/profiles", { headers: authHeaders() }).then(json<ProfilesInfo>),

  profile: (name: string) =>
    fetch(`/api/profiles/${encodeURIComponent(name)}`, { headers: authHeaders() }).then(
      json<Record<string, string>>,
    ),

  saveProfile: (name: string, updates: Record<string, string | null>) =>
    fetch(`/api/profiles/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ updates }),
    }).then(json<Record<string, string>>),

  deleteProfile: (name: string) =>
    fetch(`/api/profiles/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).then(json<{ deleted: boolean; name: string }>),

  activateProfile: (name: string | null) =>
    fetch("/api/profiles/active", {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ name }),
    }).then(json<{ active: string | null; pending_restart: string[] }>),

  /* ── process admin (guided restart, explicit init-db) ───────────────────── */

  restart: () =>
    fetch("/api/admin/restart", { method: "POST", headers: authHeaders() }).then(json<RestartResponse>),

  initDb: () =>
    fetch("/api/admin/init-db", { method: "POST", headers: authHeaders() }).then(json<DbInitReport>),

  /** Poll /api/health until the (re)started server answers, or time out. */
  waitForHealth: async (timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) return;
      } catch {
        /* server still down — keep polling */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("el servidor no volvió a responder (¿hay que relanzar `aitl ui` a mano?)");
  },

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

  toolCalls: (project: string, since?: string) =>
    fetch(
      `/api/tool-calls?project=${encodeURIComponent(project)}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
      { headers: authHeaders() },
    ).then(json<ToolCallsReport>),

  sessionGraph: (project: string, id: string, temporal = false) =>
    fetch(
      `/api/runs/${encodeURIComponent(id)}/graph?project=${encodeURIComponent(project)}${temporal ? "&temporal=1" : ""}`,
      { headers: authHeaders() },
    ).then(json<GraphData>),

  graph: (project: string, scope: "all" | "symbols" | "memory" = "all") =>
    fetch(`/api/graph?project=${encodeURIComponent(project)}&scope=${scope}`, {
      headers: authHeaders(),
    }).then(json<GraphData>),

  /* ── catalog hierarchy (Workspace tab) ──────────────────────────────────── */

  softwares: () => fetch("/api/softwares", { headers: authHeaders() }).then(json<SoftwareDoc[]>),

  repos: (project?: string, software?: string) => {
    const q = new URLSearchParams();
    if (project) q.set("project", project);
    if (software) q.set("software", software);
    const qs = q.toString();
    return fetch(`/api/repos${qs ? `?${qs}` : ""}`, { headers: authHeaders() }).then(json<RepoDoc[]>);
  },

  branches: (project?: string, repo?: string) => {
    const q = new URLSearchParams();
    if (project) q.set("project", project);
    if (repo) q.set("repo", repo);
    const qs = q.toString();
    return fetch(`/api/branches${qs ? `?${qs}` : ""}`, { headers: authHeaders() }).then(json<BranchDoc[]>);
  },

  contexts: (project: string, repo?: string, limit = 25) =>
    fetch(
      `/api/context?project=${encodeURIComponent(project)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}&limit=${limit}`,
      { headers: authHeaders() },
    ).then(json<ContextDoc[]>),

  knowledgeGraph: (project: string, entities?: NodeKind[]) =>
    fetch(
      `/api/knowledge-graph?project=${encodeURIComponent(project)}${entities ? `&entities=${entities.join(",")}` : ""}`,
      { headers: authHeaders() },
    ).then(json<GraphData>),
};
