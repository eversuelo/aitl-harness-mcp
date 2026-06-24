import {
  FileText,
  GitBranch,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { type DecisionDoc, type MemoryDoc, type MemoryInput, type PromptDoc, api } from "./api.js";

const TYPES = ["user", "feedback", "project", "reference"] as const;
const DEFAULT_PROJECT = (import.meta.env.VITE_DEFAULT_PROJECT as string) || "";
const EMPTY: MemoryInput = { project: "", slug: "", type: "project", description: "", body: "", tags: [] };

const TYPE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  user: "default",
  feedback: "secondary",
  project: "outline",
  reference: "outline",
};

type Tab = "memory" | "decisions" | "prompts";

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
