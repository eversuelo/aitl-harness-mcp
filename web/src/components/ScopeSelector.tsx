/**
 * Header scope selector — a cascading breadcrumb of the catalog hierarchy
 * `software / project / repo / branch` (ADR-0028/0031). Each level narrows the
 * next: picking a software filters the project options, the project filters the
 * repos, the repo filters the branches. Project is the global scope every tab
 * consumes; repo/branch are a "focus" that deep-links into the Workspace tab.
 */
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BRANCH_KIND_BADGE, NODE_FILL } from "@/lib/kindColors";
import { type BranchDoc, type RepoDoc, type SoftwareDoc, api } from "../api.js";

export interface ScopeFocus {
  repo?: string;
  branch?: string;
}

const ALL = "__all__";
const NONE = "__none__";

function Dot({ kind }: { kind: keyof typeof NODE_FILL }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_FILL[kind] }} />;
}

function Sep() {
  return <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />;
}

export function ScopeSelector({
  project,
  projects,
  onProjectChange,
  software,
  onSoftwareChange,
  focus,
  onFocusChange,
}: {
  project: string;
  projects: string[];
  onProjectChange: (p: string) => void;
  /** Selected software name; "" = all softwares. */
  software: string;
  onSoftwareChange: (name: string) => void;
  focus: ScopeFocus;
  onFocusChange: (f: ScopeFocus) => void;
}) {
  const [softwares, setSoftwares] = useState<SoftwareDoc[]>([]);
  const [repos, setRepos] = useState<RepoDoc[]>([]);
  const [branches, setBranches] = useState<BranchDoc[]>([]);

  useEffect(() => {
    api.softwares().then(setSoftwares).catch(() => setSoftwares([]));
    api.repos().then(setRepos).catch(() => setRepos([]));
    api.branches().then(setBranches).catch(() => setBranches([]));
  }, []);

  const swValue = software || ALL;

  const projectOptions = useMemo(() => {
    const base =
      swValue === ALL
        ? [...new Set([...projects, ...repos.map((r) => r.project)])]
        : [...new Set(softwares.find((s) => s.name === swValue)?.projects ?? [])];
    if (project && !base.includes(project)) base.unshift(project);
    return base.sort();
  }, [swValue, softwares, projects, repos, project]);

  const repoOptions = useMemo(() => repos.filter((r) => r.project === project), [repos, project]);
  const branchOptions = useMemo(
    () => branches.filter((b) => b.project === project && b.repo === focus.repo),
    [branches, project, focus.repo],
  );

  const pickSoftware = (v: string) => {
    onSoftwareChange(v === ALL ? "" : v);
    if (v !== ALL) {
      const members = softwares.find((s) => s.name === v)?.projects ?? [];
      if (members.length && !members.includes(project)) {
        onProjectChange(members[0]);
        onFocusChange({});
      }
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Select value={swValue} onValueChange={pickSoftware}>
        <SelectTrigger className="h-8 w-auto min-w-[7rem] max-w-[11rem] gap-1.5" aria-label="software">
          <Dot kind="software" />
          <SelectValue placeholder="software" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>
            <span className="text-muted-foreground">todos</span>
          </SelectItem>
          {softwares.map((s) => (
            <SelectItem key={s.name} value={s.name}>
              {s.display_name || s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Sep />
      <Select
        value={project || undefined}
        onValueChange={(p) => {
          onProjectChange(p);
          onFocusChange({});
        }}
      >
        <SelectTrigger className="h-8 w-auto min-w-[8rem] max-w-[13rem] gap-1.5" aria-label="project">
          <Dot kind="project" />
          <SelectValue placeholder="project…" />
        </SelectTrigger>
        <SelectContent>
          {projectOptions.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Sep />
      <Select
        value={focus.repo ?? NONE}
        onValueChange={(r) => onFocusChange(r === NONE ? {} : { repo: r })}
        disabled={!repoOptions.length}
      >
        <SelectTrigger className="h-8 w-auto min-w-[6.5rem] max-w-[12rem] gap-1.5" aria-label="repo">
          <Dot kind="repo" />
          <SelectValue placeholder="repo" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            <span className="text-muted-foreground">{repoOptions.length ? "— repo —" : "sin repos"}</span>
          </SelectItem>
          {repoOptions.map((r) => (
            <SelectItem key={r.name} value={r.name}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Sep />
      <Select
        value={focus.branch ?? NONE}
        onValueChange={(b) => onFocusChange({ repo: focus.repo, branch: b === NONE ? undefined : b })}
        disabled={!focus.repo || !branchOptions.length}
      >
        <SelectTrigger className="h-8 w-auto min-w-[6.5rem] max-w-[13rem] gap-1.5" aria-label="branch">
          <Dot kind="branch" />
          <SelectValue placeholder="branch" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            <span className="text-muted-foreground">
              {!focus.repo ? "elige un repo" : branchOptions.length ? "— rama —" : "sin ramas"}
            </span>
          </SelectItem>
          {branchOptions.map((b) => (
            <SelectItem key={b.name} value={b.name}>
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-xs">{b.name}</span>
                <span
                  className={`rounded-full border px-1.5 text-[10px] leading-4 ${BRANCH_KIND_BADGE[b.kind] ?? ""}`}
                >
                  {b.kind}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
