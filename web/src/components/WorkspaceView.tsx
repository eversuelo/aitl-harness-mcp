/**
 * Workspace tab — the catalog hierarchy `software → project → repo → branch`
 * (ADR-0028/0031) as a navigable tree, plus a per-node detail pane that surfaces
 * the MCP's durable work: context snapshots (`save_mcp_context`/`capture-session`),
 * runs and ADRs, merged into one recent-activity feed.
 *
 * Read-only by design: it consumes the existing /api/{softwares,repos,branches,
 * context,runs,decisions,memory} endpoints and never mutates the catalog.
 */
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Lock,
  MessageSquare,
  Network,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { BRANCH_ENV_BADGE, BRANCH_KIND_BADGE, NODE_FILL } from "@/lib/kindColors";
import {
  type BranchDoc,
  type ContextDoc,
  type DecisionDoc,
  type RepoDoc,
  type RunDoc,
  type SoftwareDoc,
  api,
} from "../api.js";

/* ── tree model ──────────────────────────────────────────────────────────── */

const NO_SOFTWARE = "__none__";

interface ProjectNode {
  project: string;
  software: string; // owning software name or NO_SOFTWARE
  repos: RepoDoc[];
}

interface SoftwareGroup {
  key: string; // software name or NO_SOFTWARE
  software: SoftwareDoc | null; // null for the orphan group
  projects: ProjectNode[];
}

type Selection =
  | { level: "software"; software: SoftwareDoc }
  | { level: "project"; project: string }
  | { level: "repo"; repo: RepoDoc }
  | { level: "branch"; branch: BranchDoc };

const selectionId = (s: Selection): string => {
  switch (s.level) {
    case "software":
      return `sw:${s.software.name}`;
    case "project":
      return `pj:${s.project}`;
    case "repo":
      return `rp:${s.repo.project}/${s.repo.name}`;
    case "branch":
      return `br:${s.branch.project}/${s.branch.repo}/${s.branch.name}`;
  }
};

/** Group the flat catalog into software → project → repo. Orphan projects (not
 *  claimed by any software) fall into a trailing "(sin software)" group. */
function buildGroups(softwares: SoftwareDoc[], projects: string[], repos: RepoDoc[]): SoftwareGroup[] {
  const reposByProject = new Map<string, RepoDoc[]>();
  for (const r of repos) {
    const list = reposByProject.get(r.project) ?? [];
    list.push(r);
    reposByProject.set(r.project, list);
  }
  const claimed = new Set<string>();
  const groups: SoftwareGroup[] = softwares.map((sw) => {
    const members = [...new Set(sw.projects ?? [])];
    for (const p of members) claimed.add(p);
    return {
      key: sw.name,
      software: sw,
      projects: members.map((p) => ({ project: p, software: sw.name, repos: reposByProject.get(p) ?? [] })),
    };
  });
  const allProjects = new Set<string>([...projects, ...reposByProject.keys()]);
  const orphans = [...allProjects].filter((p) => !claimed.has(p)).sort();
  if (orphans.length) {
    groups.push({
      key: NO_SOFTWARE,
      software: null,
      projects: orphans.map((p) => ({ project: p, software: NO_SOFTWARE, repos: reposByProject.get(p) ?? [] })),
    });
  }
  return groups;
}

/** Trunks first (main/master/develop), then the rest alphabetically. */
const BRANCH_ORDER = ["main", "master", "develop", "staging", "release", "hotfix", "feature", "other"];
function sortBranches(rows: BranchDoc[]): BranchDoc[] {
  return [...rows].sort((a, b) => {
    const ka = BRANCH_ORDER.indexOf(a.kind);
    const kb = BRANCH_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.name.localeCompare(b.name);
  });
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/* ── small shared bits ───────────────────────────────────────────────────── */

function KindDot({ kind }: { kind: keyof typeof NODE_FILL }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_FILL[kind] }} />;
}

function BranchKindBadge({ branch }: { branch: BranchDoc }) {
  return (
    <span className="flex items-center gap-1">
      <Badge variant="outline" className={BRANCH_KIND_BADGE[branch.kind] ?? BRANCH_KIND_BADGE.other}>
        {branch.kind}
      </Badge>
      {branch.environment !== "none" && (
        <Badge variant="outline" className={BRANCH_ENV_BADGE[branch.environment] ?? ""}>
          {branch.environment}
        </Badge>
      )}
      {branch.protectedBranch && <Lock className="h-3 w-3 text-muted-foreground" aria-label="protegida" />}
    </span>
  );
}

function StatTile({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/* ── activity feed (the MCP's visible work) ──────────────────────────────── */

interface ActivityItem {
  kind: "context" | "run" | "decision";
  title: string;
  meta: string;
  when?: string;
}

function mergeActivity(contexts: ContextDoc[], runs: RunDoc[], decisions: DecisionDoc[]): ActivityItem[] {
  const items: ActivityItem[] = [
    ...contexts.map((c) => ({
      kind: "context" as const,
      title: c.title || c.summary?.slice(0, 90) || c.context_id,
      meta: [c.source, c.model].filter(Boolean).join(" · "),
      when: c.created_at,
    })),
    ...runs.map((r) => ({
      kind: "run" as const,
      title: r.model,
      meta: `${r.status} · ${((r.token_usage?.input ?? 0) + (r.token_usage?.output ?? 0)).toLocaleString("en-US")} tok`,
      when: r.started_at,
    })),
    ...decisions.map((d) => ({
      kind: "decision" as const,
      title: `ADR-${d.id} — ${d.title}`,
      meta: d.status,
      when: d.created_at,
    })),
  ];
  return items
    .sort((a, b) => new Date(b.when ?? 0).getTime() - new Date(a.when ?? 0).getTime())
    .slice(0, 12);
}

const ACTIVITY_ICON: Record<ActivityItem["kind"], React.ReactNode> = {
  context: <MessageSquare className="h-3.5 w-3.5" style={{ color: NODE_FILL.context }} />,
  run: <Play className="h-3.5 w-3.5" style={{ color: NODE_FILL.run }} />,
  decision: <GitCommitHorizontal className="h-3.5 w-3.5" style={{ color: NODE_FILL.decision }} />,
};

function ActivityFeed({ items, loading }: { items: ActivityItem[]; loading: boolean }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Actividad reciente del MCP</h3>
      {loading ? (
        <p className="text-xs text-muted-foreground">Cargando…</p>
      ) : items.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map((it, i) => (
            <li key={`${it.kind}-${i}`} className="flex items-start gap-2 rounded-md border px-3 py-2">
              <span className="mt-0.5 shrink-0">{ACTIVITY_ICON[it.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{it.title}</p>
                {it.meta && <p className="text-xs text-muted-foreground">{it.meta}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(it.when)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
          Sin actividad registrada. Las llamadas MCP (<code>save_mcp_context</code>, <code>record_decision</code>) y
          los runs (<code>aitl run</code>/<code>run-host</code>) aparecen aquí.
        </p>
      )}
    </div>
  );
}

/* ── detail panes ────────────────────────────────────────────────────────── */

function ProjectDetail({
  project,
  active,
  onActivate,
  onError,
}: {
  project: string;
  active: boolean;
  onActivate: () => void;
  onError: (e: unknown) => void;
}) {
  const [counts, setCounts] = useState<{ memories: number; decisions: number; runs: number; contexts: number } | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCounts(null);
    Promise.all([
      api.list(project).catch(() => []),
      api.decisions(project).catch(() => []),
      api.runs(project).catch(() => []),
      api.contexts(project).catch(() => []),
    ])
      .then(([memories, decisions, runs, contexts]) => {
        if (cancelled) return;
        setCounts({ memories: memories.length, decisions: decisions.length, runs: runs.length, contexts: contexts.length });
        setActivity(mergeActivity(contexts, runs, decisions));
      })
      .catch((e) => !cancelled && onError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [project, onError]);

  return (
    <article className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <KindDot kind="project" />
        <h2 className="text-lg font-semibold">{project}</h2>
        <Badge variant="outline">project</Badge>
        {active ? (
          <Badge className="ml-auto">proyecto activo</Badge>
        ) : (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onActivate}>
            Usar como proyecto activo
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="memorias" value={counts?.memories ?? "…"} color={NODE_FILL.memory} />
        <StatTile label="ADRs" value={counts?.decisions ?? "…"} color={NODE_FILL.decision} />
        <StatTile label="runs" value={counts?.runs ?? "…"} color={NODE_FILL.run} />
        <StatTile label="contextos MCP" value={counts?.contexts ?? "…"} color={NODE_FILL.context} />
      </div>
      <Separator className="my-4" />
      <ActivityFeed items={activity} loading={loading} />
    </article>
  );
}

function RepoDetail({
  repo,
  branches,
  onSelectBranch,
  onError,
}: {
  repo: RepoDoc;
  branches: BranchDoc[];
  onSelectBranch: (b: BranchDoc) => void;
  onError: (e: unknown) => void;
}) {
  const [contexts, setContexts] = useState<ContextDoc[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .contexts(repo.project, repo.name)
      .then((rows) => !cancelled && setContexts(rows))
      .catch((e) => !cancelled && onError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [repo.project, repo.name, onError]);

  const rows = sortBranches(branches);
  return (
    <article className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <KindDot kind="repo" />
        <h2 className="text-lg font-semibold">{repo.name}</h2>
        <Badge variant="outline">repo</Badge>
        <span className="text-xs text-muted-foreground">en {repo.project}</span>
      </div>
      {repo.description && <p className="mb-2 text-sm text-muted-foreground">{repo.description}</p>}
      <div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
        {repo.remote && <span className="break-all">remote: {repo.remote}</span>}
        {repo.path && <span className="break-all">path: {repo.path}</span>}
      </div>

      <Separator className="my-4" />
      <h3 className="mb-2 text-sm font-semibold">Ramas ({rows.length})</h3>
      {rows.length ? (
        <div className="flex flex-col gap-1.5">
          {rows.map((b) => (
            <button
              type="button"
              key={b.name}
              onClick={() => onSelectBranch(b)}
              className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" style={{ color: NODE_FILL.branch }} />
              <span className="font-mono text-sm">{b.name}</span>
              <BranchKindBadge branch={b} />
              {b.base && <span className="text-xs text-muted-foreground">← {b.base}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{timeAgo(b.updated_at)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
          Sin ramas catalogadas. Corre <code>aitl branch sync --project {repo.project} --repo {repo.name}</code>.
        </p>
      )}

      <Separator className="my-4" />
      <ActivityFeed
        items={mergeActivity(contexts, [], [])}
        loading={loading}
      />
    </article>
  );
}

function BranchDetail({ branch }: { branch: BranchDoc }) {
  return (
    <article className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <KindDot kind="branch" />
        <h2 className="font-mono text-lg font-semibold">{branch.name}</h2>
        <BranchKindBadge branch={branch} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="repo" value={<span className="font-sans font-normal">{branch.repo}</span>} color={NODE_FILL.repo} />
        <StatTile label="project" value={<span className="font-sans font-normal">{branch.project}</span>} color={NODE_FILL.project} />
        <StatTile label="deriva de" value={branch.base ?? "— (trunk)"} color={NODE_FILL.branch} />
        <StatTile label="head" value={branch.head_sha ? branch.head_sha.slice(0, 7) : "—"} />
      </div>
      <div className="mt-4 flex flex-col gap-1 text-xs text-muted-foreground">
        {branch.remote && <span className="break-all font-mono">remote: {branch.remote}</span>}
        <span>actualizada {timeAgo(branch.updated_at)}</span>
        {branch.protectedBranch && (
          <span className="flex items-center gap-1">
            <Lock className="h-3 w-3" /> rama protegida
          </span>
        )}
      </div>
    </article>
  );
}

function SoftwareDetail({ software, onSelectProject }: { software: SoftwareDoc; onSelectProject: (p: string) => void }) {
  return (
    <article className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <KindDot kind="software" />
        <h2 className="text-lg font-semibold">{software.display_name || software.name}</h2>
        <Badge variant="outline">software</Badge>
      </div>
      {software.description && <p className="mb-3 text-sm text-muted-foreground">{software.description}</p>}
      <h3 className="mb-2 mt-4 text-sm font-semibold">Projects ({software.projects?.length ?? 0})</h3>
      <div className="flex flex-wrap gap-1.5">
        {(software.projects ?? []).map((p) => (
          <Button key={p} variant="outline" size="sm" onClick={() => onSelectProject(p)}>
            <KindDot kind="project" /> {p}
          </Button>
        ))}
        {!software.projects?.length && <p className="text-xs text-muted-foreground">Sin projects asignados.</p>}
      </div>
      {!!software.tags?.length && (
        <p className="mt-4 text-xs text-muted-foreground">{software.tags.map((t) => `#${t}`).join("  ")}</p>
      )}
    </article>
  );
}

/* ── tree rows ───────────────────────────────────────────────────────────── */

function TreeRow({
  depth,
  expanded,
  onToggle,
  onSelect,
  selected,
  icon,
  label,
  trailing,
  hasChildren,
}: {
  depth: number;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  selected: boolean;
  icon: React.ReactNode;
  label: React.ReactNode;
  trailing?: React.ReactNode;
  hasChildren: boolean;
}) {
  return (
    <div
      className={`group flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-sm transition-colors hover:bg-accent ${
        selected ? "bg-accent ring-1 ring-primary" : ""
      }`}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      tabIndex={0}
    >
      {hasChildren ? (
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={expanded ? "colapsar" : "expandir"}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

/* ── main view ───────────────────────────────────────────────────────────── */

export interface WorkspaceFocus {
  repo?: string;
  branch?: string;
}

export function WorkspaceView({
  project,
  software = "",
  focus,
  onProjectChange,
  onError,
}: {
  project: string;
  /** Header-selected software; "" shows every group. */
  software?: string;
  /** Header-selected repo/branch to deep-link into the tree. */
  focus?: WorkspaceFocus;
  onProjectChange: (p: string) => void;
  onError: (e: unknown) => void;
}) {
  const [softwares, setSoftwares] = useState<SoftwareDoc[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [repos, setRepos] = useState<RepoDoc[]>([]);
  const [branches, setBranches] = useState<BranchDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    onError(null);
    try {
      const [sw, pj, rp, br] = await Promise.all([
        api.softwares(),
        api.projects().catch(() => [] as string[]),
        api.repos(),
        api.branches(),
      ]);
      setSoftwares(sw);
      setProjects(pj);
      setRepos(rp);
      setBranches(br);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const all = buildGroups(softwares, projects, repos);
    // The header's software pick scopes the whole tab to that group.
    return software ? all.filter((g) => g.software?.name === software) : all;
  }, [softwares, projects, repos, software]);

  const branchesByRepo = useMemo(() => {
    const m = new Map<string, BranchDoc[]>();
    for (const b of branches) {
      const k = `${b.project}/${b.repo}`;
      const list = m.get(k) ?? [];
      list.push(b);
      m.set(k, list);
    }
    return m;
  }, [branches]);

  // First load: expand the chain that contains the active project.
  useEffect(() => {
    if (!groups.length) return;
    setExpanded((prev) => {
      if (prev.size) return prev;
      const next = new Set<string>();
      for (const g of groups) {
        next.add(`sw:${g.key}`);
        for (const p of g.projects) {
          if (p.project === project) {
            next.add(`pj:${p.project}`);
            for (const r of p.repos) next.add(`rp:${r.project}/${r.name}`);
          }
        }
      }
      return next;
    });
  }, [groups, project]);

  // Deep-link from the header selector: focus a repo (or branch) once data is loaded.
  useEffect(() => {
    if (!focus?.repo) return;
    const r = repos.find((x) => x.project === project && x.name === focus.repo);
    if (!r) return;
    const owner = groups.find((g) => g.projects.some((p) => p.project === project));
    setExpanded((prev) => {
      const next = new Set(prev);
      if (owner) next.add(`sw:${owner.key}`);
      next.add(`pj:${project}`);
      next.add(`rp:${r.project}/${r.name}`);
      return next;
    });
    if (focus.branch) {
      const b = branches.find(
        (x) => x.project === project && x.repo === focus.repo && x.name === focus.branch,
      );
      if (b) {
        setSelection({ level: "branch", branch: b });
        return;
      }
    }
    setSelection({ level: "repo", repo: r });
  }, [focus, repos, branches, groups, project]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // Name filter: keep any node whose own name matches, or that has a matching descendant.
  const q = filter.trim().toLowerCase();
  const matches = (s: string) => !q || s.toLowerCase().includes(q);
  const visibleGroups = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => {
        const projectsKept = g.projects
          .map((p) => {
            const reposKept = p.repos.filter(
              (r) =>
                matches(r.name) ||
                (branchesByRepo.get(`${r.project}/${r.name}`) ?? []).some((b) => matches(b.name)),
            );
            return matches(p.project) ? p : { ...p, repos: reposKept };
          })
          .filter(
            (p) => matches(p.project) || p.repos.length > 0,
          );
        const groupName = g.software ? g.software.name : "sin software";
        if (matches(groupName)) return g;
        return { ...g, projects: projectsKept };
      })
      .filter((g) => matches(g.software ? g.software.name : "sin software") || g.projects.length > 0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `matches` closes over q
  }, [groups, q, branchesByRepo]);

  const selId = selection ? selectionId(selection) : null;

  const totals = useMemo(
    () => ({
      softwares: softwares.length,
      projects: new Set([...projects, ...repos.map((r) => r.project)]).size,
      repos: repos.length,
      branches: branches.length,
    }),
    [softwares, projects, repos, branches],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(320px,38%)_1fr]">
      <section className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b p-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filtrar por nombre…"
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} aria-label="refrescar">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {totals.softwares} software · {totals.projects} projects · {totals.repos} repos · {totals.branches} ramas
        </div>
        <div className="max-h-[45vh] min-h-0 flex-1 overflow-y-auto p-2 md:max-h-none" role="tree">
          {visibleGroups.map((g) => {
            const swId = `sw:${g.key}`;
            const swOpen = expanded.has(swId) || !!q;
            return (
              <div key={g.key}>
                <TreeRow
                  depth={0}
                  hasChildren={g.projects.length > 0}
                  expanded={swOpen}
                  onToggle={() => toggle(swId)}
                  selected={selId === swId}
                  onSelect={() =>
                    g.software ? setSelection({ level: "software", software: g.software }) : toggle(swId)
                  }
                  icon={<Boxes className="h-4 w-4" style={{ color: NODE_FILL.software }} />}
                  label={
                    g.software ? (
                      <span className="font-medium">{g.software.display_name || g.software.name}</span>
                    ) : (
                      <span className="italic text-muted-foreground">sin software</span>
                    )
                  }
                  trailing={
                    <span className="text-xs text-muted-foreground">{g.projects.length}</span>
                  }
                />
                {swOpen &&
                  g.projects.map((p) => {
                    const pjId = `pj:${p.project}`;
                    const pjOpen = expanded.has(pjId) || !!q;
                    return (
                      <div key={p.project}>
                        <TreeRow
                          depth={1}
                          hasChildren={p.repos.length > 0}
                          expanded={pjOpen}
                          onToggle={() => toggle(pjId)}
                          selected={selId === pjId}
                          onSelect={() => setSelection({ level: "project", project: p.project })}
                          icon={<Folder className="h-4 w-4" style={{ color: NODE_FILL.project }} />}
                          label={
                            <span className={p.project === project ? "font-semibold" : ""}>
                              {p.project}
                              {p.project === project && (
                                <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">
                                  activo
                                </Badge>
                              )}
                            </span>
                          }
                          trailing={<span className="text-xs text-muted-foreground">{p.repos.length}</span>}
                        />
                        {pjOpen &&
                          p.repos.map((r) => {
                            const rpId = `rp:${r.project}/${r.name}`;
                            const rpOpen = expanded.has(rpId) || !!q;
                            const brs = sortBranches(branchesByRepo.get(`${r.project}/${r.name}`) ?? []);
                            return (
                              <div key={r.name}>
                                <TreeRow
                                  depth={2}
                                  hasChildren={brs.length > 0}
                                  expanded={rpOpen}
                                  onToggle={() => toggle(rpId)}
                                  selected={selId === rpId}
                                  onSelect={() => setSelection({ level: "repo", repo: r })}
                                  icon={<FolderGit2 className="h-4 w-4" style={{ color: NODE_FILL.repo }} />}
                                  label={<span className="font-mono text-xs sm:text-sm">{r.name}</span>}
                                  trailing={<span className="text-xs text-muted-foreground">{brs.length}</span>}
                                />
                                {rpOpen &&
                                  brs
                                    .filter((b) => matches(b.name) || matches(r.name) || matches(p.project))
                                    .map((b) => {
                                      const brId = `br:${b.project}/${b.repo}/${b.name}`;
                                      return (
                                        <TreeRow
                                          key={b.name}
                                          depth={3}
                                          hasChildren={false}
                                          selected={selId === brId}
                                          onSelect={() => setSelection({ level: "branch", branch: b })}
                                          icon={<GitBranch className="h-3.5 w-3.5" style={{ color: NODE_FILL.branch }} />}
                                          label={<span className="font-mono text-xs">{b.name}</span>}
                                          trailing={
                                            <Badge
                                              variant="outline"
                                              className={`px-1.5 py-0 text-[10px] ${BRANCH_KIND_BADGE[b.kind] ?? ""}`}
                                            >
                                              {b.kind}
                                            </Badge>
                                          }
                                        />
                                      );
                                    })}
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
          {!visibleGroups.length && !loading && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              Catálogo vacío. Corre <code>aitl init</code> o <code>aitl software add</code> +{" "}
              <code>aitl repo add</code> + <code>aitl branch sync</code>.
            </div>
          )}
        </div>
      </section>

      <section className="min-h-0 overflow-y-auto">
        {selection?.level === "software" && (
          <SoftwareDetail
            software={selection.software}
            onSelectProject={(p) => setSelection({ level: "project", project: p })}
          />
        )}
        {selection?.level === "project" && (
          <ProjectDetail
            project={selection.project}
            active={selection.project === project}
            onActivate={() => onProjectChange(selection.project)}
            onError={onError}
          />
        )}
        {selection?.level === "repo" && (
          <RepoDetail
            repo={selection.repo}
            branches={branchesByRepo.get(`${selection.repo.project}/${selection.repo.name}`) ?? []}
            onSelectBranch={(b) => setSelection({ level: "branch", branch: b })}
            onError={onError}
          />
        )}
        {selection?.level === "branch" && <BranchDetail branch={selection.branch} />}
        {!selection && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
            <Network className="h-10 w-10 opacity-30" />
            <p className="text-sm">Selecciona un nodo del árbol para ver su detalle y la actividad del MCP.</p>
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs">
              {(["software", "project", "repo", "branch"] as const).map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <KindDot kind={k} /> {k}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
