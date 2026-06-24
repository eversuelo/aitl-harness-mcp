import { useCallback, useEffect, useMemo, useState } from "react";
import { type MemoryDoc, type MemoryInput, api } from "./api.js";

const TYPES = ["user", "feedback", "project", "reference"] as const;
const DEFAULT_PROJECT = (import.meta.env.VITE_DEFAULT_PROJECT as string) || "";

const EMPTY: MemoryInput = { project: "", slug: "", type: "project", description: "", body: "", tags: [] };

export function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [items, setItems] = useState<MemoryDoc[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<MemoryInput>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.projects()
      .then((ps) => {
        setProjects(ps);
        setProject((p) => p || ps[0] || "");
      })
      .catch((e) => setError(String(e.message)));
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    setError(null);
    try {
      const rows = query.trim() ? await api.search(project, query.trim()) : await api.list(project);
      setItems(rows);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project, query]);

  useEffect(() => {
    void refresh();
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const projectOptions = useMemo(
    () => [...new Set([project, ...projects].filter(Boolean))],
    [project, projects],
  );

  return (
    <div className="app">
      <header>
        <h1>AITL · Memory Admin</h1>
        <div className="proj">
          <label>project</label>
          <input
            list="projects"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="project…"
          />
          <datalist id="projects">
            {projectOptions.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="cols">
        <section className="list">
          <div className="toolbar">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && refresh()}
              placeholder="semantic search… (Enter)"
            />
            <button onClick={() => refresh()} disabled={!project}>Search</button>
            <button onClick={startNew} disabled={!project}>+ New</button>
          </div>
          <ul>
            {items.map((doc) => (
              <li key={doc.slug} onClick={() => startEdit(doc)}>
                <div className="row">
                  <span className="slug">{doc.slug}</span>
                  {typeof doc.score === "number" && <span className="score">{doc.score.toFixed(3)}</span>}
                </div>
                <div className="meta">
                  <span className={`tag t-${doc.type}`}>{doc.type}</span>
                  {doc.category && <span className="cat">{doc.category}</span>}
                  <span className="desc">{doc.description}</span>
                </div>
              </li>
            ))}
            {!items.length && <li className="empty">No memories. Create one with “+ New”.</li>}
          </ul>
        </section>

        <section className="editor">
          {editing ? (
            <>
              <div className="field">
                <label>slug</label>
                <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              </div>
              <div className="field">
                <label>type</label>
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>description</label>
                <input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
              <div className="field">
                <label>tags (comma-separated)</label>
                <input
                  value={draft.tags.join(", ")}
                  onChange={(e) =>
                    setDraft({ ...draft, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                  }
                />
              </div>
              <div className="field grow">
                <label>body (markdown)</label>
                <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </div>
              <div className="actions">
                <button className="primary" onClick={save} disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                {draft.slug && (
                  <button className="danger" onClick={() => remove(draft.slug)} disabled={busy}>
                    Delete
                  </button>
                )}
                <span className="hint">classified + re-embedded on save (same path as MCP write_memory)</span>
              </div>
            </>
          ) : (
            <div className="placeholder">Select a memory to edit, or “+ New”.</div>
          )}
        </section>
      </div>
    </div>
  );
}
