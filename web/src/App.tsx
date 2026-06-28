import {
  FileText,
  GitBranch,
  Loader2,
  MessageSquare,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  type DecisionDoc,
  type GraphData,
  type GraphNode,
  type MemoryDoc,
  type MemoryInput,
  type PromptDoc,
  api,
} from "./api.js";

const TYPES = ["user", "feedback", "project", "reference"] as const;
const DEFAULT_PROJECT = (import.meta.env.VITE_DEFAULT_PROJECT as string) || "";
const EMPTY: MemoryInput = { project: "", slug: "", type: "project", description: "", body: "", tags: [] };

const TYPE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  user: "default",
  feedback: "secondary",
  project: "outline",
  reference: "outline",
};

type Tab = "memory" | "decisions" | "prompts" | "graph";

export function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [tab, setTab] = useState<Tab>("memory");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects()
      .then((ps) => {
        setProjects(ps);
        setProject((p) => p || ps[0] || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <FileText className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight">AITL · Memory Admin</h1>
            <p className="text-xs text-muted-foreground">durable state · MongoDB Atlas Vector Search</p>
          </div>
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="ml-4">
            <TabsList>
              <TabsTrigger value="memory">
                <FileText /> Memory
              </TabsTrigger>
              <TabsTrigger value="decisions">
                <GitBranch /> Decisions
              </TabsTrigger>
              <TabsTrigger value="prompts">
                <MessageSquare /> Prompts
              </TabsTrigger>
              <TabsTrigger value="graph">
                <Network /> Graph
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">project</Label>
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="h-8 w-52">
              <SelectValue placeholder="select a project…" />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([project, ...projects].filter(Boolean))].map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/15 px-5 py-2 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setError(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "memory" && <MemoryView project={project} onError={setError} />}
        {tab === "decisions" && <DecisionsView project={project} onError={setError} />}
        {tab === "prompts" && <PromptsView project={project} onError={setError} />}
        {tab === "graph" && <GraphView project={project} onError={setError} />}
      </div>
    </div>
  );
}

/* ── shared layout ───────────────────────────────────────────────────────── */
function TwoPane({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(320px,38%)_1fr]">
      <section className="flex min-h-0 flex-col border-r">{list}</section>
      <section className="min-h-0 overflow-y-auto">{detail}</section>
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  );
}

/* ── memory ──────────────────────────────────────────────────────────────── */
function MemoryView({ project, onError }: { project: string; onError: (e: string | null) => void }) {
  const [items, setItems] = useState<MemoryDoc[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MemoryDoc | null>(null);
  const [draft, setDraft] = useState<MemoryInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!project) return;
    onError(null);
    setLoading(true);
    try {
      setItems(query.trim() ? await api.search(project, query.trim()) : await api.list(project));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, query, onError]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh on project change
  useEffect(() => {
    setSelected(null);
    setDraft(null);
    void refresh();
  }, [project]);

  const save = async () => {
    if (!draft) return;
    if (!draft.slug.trim() || !draft.body.trim()) return onError("slug and body are required.");
    setBusy(true);
    onError(null);
    try {
      await api.save({ ...draft, project });
      setDraft(null);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (slug: string) => {
    if (!confirm(`Delete memory "${slug}"?`)) return;
    setBusy(true);
    try {
      await api.remove(project, slug);
      setSelected(null);
      setDraft(null);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TwoPane
      list={
        <>
          <div className="flex items-center gap-2 border-b p-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && refresh()}
                placeholder="semantic search… (Enter)"
                className="pl-8"
              />
            </div>
            <Button variant="outline" size="icon" onClick={refresh} disabled={!project || loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button size="sm" onClick={() => { setDraft({ ...EMPTY, project }); setSelected(null); }} disabled={!project}>
              <Plus className="h-4 w-4" /> New
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="flex flex-col gap-2">
              {items.map((doc) => (
                <Card
                  key={doc.slug}
                  onClick={() => { setSelected(doc); setDraft(null); }}
                  className={`cursor-pointer p-3 transition-colors hover:bg-accent ${
                    selected?.slug === doc.slug ? "border-primary ring-1 ring-primary" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{doc.slug}</span>
                    {typeof doc.score === "number" && (
                      <span className="shrink-0 font-mono text-xs text-primary">{doc.score.toFixed(3)}</span>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge variant={TYPE_VARIANT[doc.type] ?? "outline"}>{doc.type}</Badge>
                    {doc.category && <span className="text-xs text-muted-foreground">{doc.category}</span>}
                  </div>
                  {doc.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{doc.description}</p>
                  )}
                </Card>
              ))}
              {!items.length && !loading && (
                <div className="px-2 py-10 text-center text-sm text-muted-foreground">No memories yet.</div>
              )}
            </div>
          </div>
        </>
      }
      detail={
        draft ? (
          <MemoryEditor
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onCancel={() => setDraft(null)}
            onDelete={draft.slug ? () => remove(draft.slug) : undefined}
            busy={busy}
          />
        ) : selected ? (
          <article className="mx-auto max-w-3xl p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{selected.slug}</h2>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant={TYPE_VARIANT[selected.type] ?? "outline"}>{selected.type}</Badge>
                  {selected.category && <span className="text-xs text-muted-foreground">{selected.category}</span>}
                  {selected.tags?.map((t) => (
                    <span key={t} className="text-xs text-muted-foreground">#{t}</span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      project: selected.project,
                      slug: selected.slug,
                      type: selected.type,
                      description: selected.description ?? "",
                      body: selected.body ?? "",
                      tags: selected.tags ?? [],
                    })
                  }
                >
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
                <Button variant="destructive" size="sm" onClick={() => remove(selected.slug)} disabled={busy}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {selected.description && <p className="mb-4 text-sm text-muted-foreground">{selected.description}</p>}
            <Separator className="mb-4" />
            <Markdown>{selected.body || "_(empty)_"}</Markdown>
          </article>
        ) : (
          <Empty icon={<FileText className="h-10 w-10 opacity-30" />} text="Select a memory, or create a new one." />
        )
      }
    />
  );
}

function MemoryEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  onDelete,
  busy,
}: {
  draft: MemoryInput;
  setDraft: (d: MemoryInput) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="slug">slug</Label>
          <Input id="slug" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="kebab-case-id" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="type">type</Label>
          <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
            <SelectTrigger id="type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="description">description</Label>
        <Input id="description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="one-line summary used for recall" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tags">tags</Label>
        <Input id="tags" value={draft.tags.join(", ")} onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="comma, separated" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="body">body (markdown)</Label>
        <Textarea id="body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="min-h-[18rem] font-mono text-xs" placeholder="The memory content. [[wiki-links]] connect related memories." />
      </div>
      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        {onDelete && (
          <Button variant="destructive" onClick={onDelete} disabled={busy}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">classified + re-embedded on save</span>
      </div>
    </div>
  );
}

/* ── decisions / ADRs ──────────────────────────────────────────────────────── */
function DecisionsView({ project, onError }: { project: string; onError: (e: string | null) => void }) {
  const [items, setItems] = useState<DecisionDoc[]>([]);
  const [selected, setSelected] = useState<DecisionDoc | null>(null);
  const [loading, setLoading] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load on project change
  useEffect(() => {
    if (!project) return;
    setLoading(true);
    setSelected(null);
    api
      .decisions(project)
      .then((rows) => {
        setItems(rows);
        setSelected(rows[0] ?? null);
      })
      .catch((e) => onError((e as Error).message))
      .finally(() => setLoading(false));
  }, [project]);

  const md = (d: DecisionDoc) =>
    `## Context\n\n${d.context || "_—_"}\n\n## Decision\n\n${d.decision || "_—_"}\n\n## Consequences\n\n${d.consequences || "_—_"}`;

  return (
    <TwoPane
      list={
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
          <div className="flex flex-col gap-2">
            {items.map((d) => (
              <Card
                key={d.id}
                onClick={() => setSelected(d)}
                className={`cursor-pointer p-3 transition-colors hover:bg-accent ${
                  selected?.id === d.id ? "border-primary ring-1 ring-primary" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">ADR-{d.id}</span>
                  <Badge variant={d.status === "accepted" ? "default" : "secondary"} className="ml-auto">
                    {d.status}
                  </Badge>
                </div>
                <p className="mt-1 text-sm font-medium leading-snug">{d.title}</p>
              </Card>
            ))}
            {!items.length && !loading && (
              <div className="px-2 py-10 text-center text-sm text-muted-foreground">
                No decisions for this project.
              </div>
            )}
          </div>
        </div>
      }
      detail={
        selected ? (
          <article className="mx-auto max-w-3xl p-6">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">ADR-{selected.id}</span>
              <Badge variant={selected.status === "accepted" ? "default" : "secondary"}>{selected.status}</Badge>
            </div>
            <h2 className="mb-4 text-xl font-semibold">{selected.title}</h2>
            <Separator className="mb-4" />
            <Markdown>{md(selected)}</Markdown>
          </article>
        ) : (
          <Empty icon={<GitBranch className="h-10 w-10 opacity-30" />} text="No decision selected." />
        )
      }
    />
  );
}

/* ── prompts ──────────────────────────────────────────────────────────────── */
function PromptsView({ project, onError }: { project: string; onError: (e: string | null) => void }) {
  const [items, setItems] = useState<PromptDoc[]>([]);
  const [loading, setLoading] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load on project change
  useEffect(() => {
    if (!project) return;
    setLoading(true);
    api
      .prompts(project)
      .then(setItems)
      .catch((e) => onError((e as Error).message))
      .finally(() => setLoading(false));
  }, [project]);

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h2 className="mb-4 text-lg font-semibold">Prompt history</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="flex flex-col gap-3">
        {items.map((p, i) => (
          <Card key={`${p.created_at}-${i}`} className="p-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              {p.source && <Badge variant="outline">{p.source}</Badge>}
              {p.created_at && <span>{new Date(p.created_at).toLocaleString()}</span>}
              {p.tags?.map((t) => (
                <span key={t}>#{t}</span>
              ))}
            </div>
            <Markdown>{p.prompt}</Markdown>
          </Card>
        ))}
        {!items.length && !loading && (
          <div className="py-10 text-center text-sm text-muted-foreground">No prompts recorded yet.</div>
        )}
      </div>
    </div>
  );
}

// ── Graph view ───────────────────────────────────────────────────────────────
type GraphScope = "all" | "symbols" | "memory";
const VW = 960;
const VH = 640;
const MAX_NODES = 300;
const NODE_FILL: Record<GraphNode["kind"], string> = { symbol: "#6366f1", memory: "#f59e0b" };

/** Deterministic Fruchterman–Reingold-style force layout (pure, no deps). */
function computeLayout(nodes: GraphNode[], edges: GraphData["edges"]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const N = nodes.length;
  if (!N) return pos;
  const R = Math.min(VW, VH) * 0.36;
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / N;
    pos.set(n.id, { x: VW / 2 + Math.cos(a) * R, y: VH / 2 + Math.sin(a) * R });
  });
  const links = edges.filter((e) => pos.has(e.source) && pos.has(e.target));
  const k = Math.sqrt((VW * VH) / N) * 0.8;
  const iters = N > 120 ? 120 : 300;
  for (let it = 0; it < iters; it++) {
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));
    for (let i = 0; i < N; i++) {
      const a = pos.get(nodes[i].id)!;
      for (let j = i + 1; j < N; j++) {
        const b = pos.get(nodes[j].id)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (k * k) / d;
        const da = disp.get(nodes[i].id)!;
        const db = disp.get(nodes[j].id)!;
        da.x += (dx / d) * f;
        da.y += (dy / d) * f;
        db.x -= (dx / d) * f;
        db.y -= (dy / d) * f;
      }
    }
    for (const e of links) {
      const a = pos.get(e.source)!;
      const b = pos.get(e.target)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      const da = disp.get(e.source)!;
      const db = disp.get(e.target)!;
      da.x -= (dx / d) * f;
      da.y -= (dy / d) * f;
      db.x += (dx / d) * f;
      db.y += (dy / d) * f;
    }
    const temp = k * (1 - it / iters);
    for (const n of nodes) {
      const dp = disp.get(n.id)!;
      const d = Math.hypot(dp.x, dp.y) || 0.01;
      const p = pos.get(n.id)!;
      p.x = Math.max(24, Math.min(VW - 24, p.x + (dp.x / d) * Math.min(d, temp)));
      p.y = Math.max(24, Math.min(VH - 24, p.y + (dp.y / d) * Math.min(d, temp)));
    }
  }
  return pos;
}

function GraphView({ project, onError }: { project: string; onError: (m: string) => void }) {
  const [scope, setScope] = useState<GraphScope>("memory");
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      setData(await api.graph(project, scope));
      setView({ scale: 1, tx: 0, ty: 0 });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, scope, onError]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load already closes over deps
  useEffect(() => {
    void load();
  }, [load]);

  // Cap very large graphs to the highest-ranked nodes so the SVG stays responsive.
  const { nodes, edges, capped } = useMemo(() => {
    let ns = data.nodes;
    let cap = false;
    if (ns.length > MAX_NODES) {
      ns = [...ns].sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0)).slice(0, MAX_NODES);
      cap = true;
    }
    const keep = new Set(ns.map((n) => n.id));
    return { nodes: ns, edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)), capped: cap };
  }, [data]);

  const pos = useMemo(() => computeLayout(nodes, edges), [nodes, edges]);
  const showLabels = nodes.length <= 60;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-5 py-2.5">
        <h2 className="text-sm font-semibold">Graph</h2>
        <Select value={scope} onValueChange={(v) => setScope(v as GraphScope)}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="memory">memory (links)</SelectItem>
            <SelectItem value="symbols">symbols (refs)</SelectItem>
            <SelectItem value="all">all</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
        <div className="ml-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: NODE_FILL.symbol }} /> symbol
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: NODE_FILL.memory }} /> memory
          </span>
          <span>· {nodes.length} nodes · {edges.length} edges</span>
          {capped && <Badge variant="outline">top {MAX_NODES} by rank</Badge>}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">scroll = zoom · drag = pan</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-muted/20">
        {!loading && !nodes.length ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            No graph for “{project}” at scope “{scope}”. Memory edges need <code>[[wiki-links]]</code>; symbol edges
            need a built repo map (<code>aitl repomap</code>).
          </div>
        ) : (
          <svg
            className="h-full w-full cursor-grab active:cursor-grabbing"
            viewBox={`0 0 ${VW} ${VH}`}
            preserveAspectRatio="xMidYMid meet"
            onWheel={(e) => {
              const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
              setView((v) => ({ ...v, scale: Math.max(0.3, Math.min(4, v.scale * f)) }));
            }}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX - view.tx, y: e.clientY - view.ty };
              (e.target as Element).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (drag.current) setView((v) => ({ ...v, tx: e.clientX - drag.current!.x, ty: e.clientY - drag.current!.y }));
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          >
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
              {edges.map((e, i) => {
                const a = pos.get(e.source);
                const b = pos.get(e.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={`${e.source}-${e.target}-${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={e.type === "ref" ? "#a5b4fc" : "#fcd34d"}
                    strokeWidth={0.6}
                    strokeOpacity={0.6}
                  />
                );
              })}
              {nodes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const r = n.kind === "memory" ? 7 : 4 + Math.min(8, (n.pagerank ?? 0) * 12);
                const active = hover === n.id;
                return (
                  <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                    <circle cx={p.x} cy={p.y} r={r} fill={NODE_FILL[n.kind]} stroke={active ? "#111827" : "#fff"} strokeWidth={active ? 1.5 : 0.8}>
                      <title>{`${n.kind}: ${n.label}${n.file ? `\n${n.file}` : ""}${n.category ? `\n#${n.category}` : ""}`}</title>
                    </circle>
                    {(showLabels || active) && (
                      <text x={p.x + r + 2} y={p.y + 3} fontSize={7} fill="currentColor" className="pointer-events-none select-none">
                        {n.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}
