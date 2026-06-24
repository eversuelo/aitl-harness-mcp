import { FileText, Loader2, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { type MemoryDoc, type MemoryInput, api } from "./api.js";

const TYPES = ["user", "feedback", "project", "reference"] as const;
const DEFAULT_PROJECT = (import.meta.env.VITE_DEFAULT_PROJECT as string) || "";
const EMPTY: MemoryInput = { project: "", slug: "", type: "project", description: "", body: "", tags: [] };

const TYPE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  user: "default",
  feedback: "secondary",
  project: "outline",
  reference: "outline",
};

export function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [items, setItems] = useState<MemoryDoc[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<MemoryInput>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .projects()
      .then((ps) => {
        setProjects(ps);
        setProject((p) => p || ps[0] || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    setError(null);
    setLoading(true);
    try {
      const rows = query.trim() ? await api.search(project, query.trim()) : await api.list(project);
      setItems(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh on project change only
  useEffect(() => {
    void refresh();
  }, [project]);

  const startNew = () => {
    setDraft({ ...EMPTY, project });
    setEditing(true);
  };

  const startEdit = (doc: MemoryDoc) => {
    setDraft({
      project: doc.project,
      slug: doc.slug,
      type: doc.type,
      description: doc.description ?? "",
      body: doc.body ?? "",
      tags: doc.tags ?? [],
    });
    setEditing(true);
  };

  const save = async () => {
    if (!draft.slug.trim() || !draft.body.trim()) {
      setError("slug and body are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.save({ ...draft, project });
      setEditing(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (slug: string) => {
    if (!confirm(`Delete memory "${slug}" from "${project}"?`)) return;
    setBusy(true);
    try {
      await api.remove(project, slug);
      if (draft.slug === slug) setEditing(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <FileText className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight">AITL · Memory Admin</h1>
            <p className="text-xs text-muted-foreground">durable memory · MongoDB Atlas Vector Search</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">project</Label>
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="h-8 w-56">
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,40%)_1fr]">
        {/* List */}
        <section className="flex min-h-0 flex-col border-r">
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
            <Button variant="outline" size="icon" onClick={() => refresh()} disabled={!project || loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button size="sm" onClick={startNew} disabled={!project}>
              <Plus className="h-4 w-4" /> New
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="flex flex-col gap-2">
              {items.map((doc) => {
                const active = editing && draft.slug === doc.slug;
                return (
                  <Card
                    key={doc.slug}
                    onClick={() => startEdit(doc)}
                    className={`cursor-pointer p-3 transition-colors hover:bg-accent ${
                      active ? "border-primary ring-1 ring-primary" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{doc.slug}</span>
                      {typeof doc.score === "number" && (
                        <span className="shrink-0 font-mono text-xs text-primary">{doc.score.toFixed(3)}</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Badge variant={TYPE_VARIANT[doc.type] ?? "outline"} className="shrink-0">
                        {doc.type}
                      </Badge>
                      {doc.category && <span className="text-xs text-muted-foreground">{doc.category}</span>}
                    </div>
                    {doc.description && (
                      <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{doc.description}</p>
                    )}
                  </Card>
                );
              })}
              {!items.length && !loading && (
                <div className="px-2 py-10 text-center text-sm text-muted-foreground">
                  No memories yet. Create one with <span className="font-medium">New</span>.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Editor */}
        <section className="min-h-0 overflow-y-auto">
          {editing ? (
            <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="slug">slug</Label>
                  <Input
                    id="slug"
                    value={draft.slug}
                    onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                    placeholder="kebab-case-id"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="type">type</Label>
                  <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
                    <SelectTrigger id="type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">description</Label>
                <Input
                  id="description"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="one-line summary used for recall"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tags">tags</Label>
                <Input
                  id="tags"
                  value={draft.tags.join(", ")}
                  onChange={(e) =>
                    setDraft({ ...draft, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                  }
                  placeholder="comma, separated"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="body">body (markdown)</Label>
                <Textarea
                  id="body"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  className="min-h-[16rem] font-mono text-xs"
                  placeholder="The memory content. [[wiki-links]] connect related memories."
                />
              </div>

              <Separator />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={save} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </Button>
                <Button variant="outline" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
                {draft.slug && (
                  <Button variant="destructive" onClick={() => remove(draft.slug)} disabled={busy}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  classified + re-embedded on save (same path as MCP write_memory)
                </span>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <FileText className="h-10 w-10 opacity-30" />
              <p className="text-sm">Select a memory to edit, or create a new one.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
