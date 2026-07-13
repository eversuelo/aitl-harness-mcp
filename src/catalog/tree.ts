/**
 * Catalog tree — the hierarchy `software → project → repo → branch` (ADR-0028/0031)
 * as pure build + render functions, so `aitl tree` (and tests) never touch Mongo here.
 *
 * `buildCatalogTree` groups the flat catalog rows; projects not claimed by any
 * software land in a trailing synthetic group (`software: null`). `renderCatalogTree`
 * draws unicode box-drawing lines with optional ANSI color (mirrors the web
 * Workspace tab: software red, project violet, repo green, branch sky).
 */

export interface TreeSoftware {
  name: string;
  display_name?: string | null;
  description?: string | null;
  projects?: string[] | null;
}

export interface TreeRepo {
  project: string;
  name: string;
  software?: string | null;
  remote?: string | null;
  branch?: string | null;
}

export interface TreeBranch {
  project: string;
  repo: string;
  name: string;
  kind?: string | null;
  environment?: string | null;
  base?: string | null;
  protectedBranch?: boolean | null;
}

export interface CatalogTreeInput {
  softwares: TreeSoftware[];
  repos: TreeRepo[];
  branches: TreeBranch[];
  /** Extra known project scopes (e.g. from the memory store) to surface even without repos. */
  projects?: string[];
  /** Keep only this project (and the softwares that contain it). */
  projectFilter?: string;
  /** Keep only this software group. */
  softwareFilter?: string;
}

export interface RepoNode {
  repo: TreeRepo;
  branches: TreeBranch[];
}

export interface ProjectNode {
  project: string;
  repos: RepoNode[];
}

export interface SoftwareNode {
  /** null = synthetic "(sin software)" group holding orphan projects. */
  software: TreeSoftware | null;
  projects: ProjectNode[];
}

/** Trunks first, then the rest; stable alphabetical within a kind. */
const KIND_ORDER = ["main", "master", "develop", "staging", "release", "hotfix", "feature", "other"];

export function sortBranchRows(rows: TreeBranch[]): TreeBranch[] {
  return [...rows].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind ?? "other");
    const kb = KIND_ORDER.indexOf(b.kind ?? "other");
    if (ka !== kb) return ka - kb;
    return a.name.localeCompare(b.name);
  });
}

export function buildCatalogTree(input: CatalogTreeInput): SoftwareNode[] {
  const { softwares, repos, branches, projects = [], projectFilter, softwareFilter } = input;

  const branchesByRepo = new Map<string, TreeBranch[]>();
  for (const b of branches) {
    const k = `${b.project}/${b.repo}`;
    (branchesByRepo.get(k) ?? branchesByRepo.set(k, []).get(k)!).push(b);
  }

  const reposByProject = new Map<string, TreeRepo[]>();
  for (const r of repos) {
    (reposByProject.get(r.project) ?? reposByProject.set(r.project, []).get(r.project)!).push(r);
  }

  const projectNode = (project: string): ProjectNode => ({
    project,
    repos: (reposByProject.get(project) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((repo) => ({
        repo,
        branches: sortBranchRows(branchesByRepo.get(`${repo.project}/${repo.name}`) ?? []),
      })),
  });

  const claimed = new Set<string>();
  let nodes: SoftwareNode[] = softwares.map((sw) => {
    const members = [...new Set(sw.projects ?? [])];
    for (const p of members) claimed.add(p);
    return { software: sw, projects: members.sort().map(projectNode) };
  });

  // Orphans: projects seen anywhere (explicit list, repos or branches) but unclaimed.
  const seen = new Set<string>([
    ...projects,
    ...reposByProject.keys(),
    ...branches.map((b) => b.project),
  ]);
  const orphans = [...seen].filter((p) => !claimed.has(p)).sort();
  if (orphans.length) nodes.push({ software: null, projects: orphans.map(projectNode) });

  if (softwareFilter) {
    nodes = nodes.filter((n) => (n.software?.name ?? "") === softwareFilter);
  }
  if (projectFilter) {
    nodes = nodes
      .map((n) => ({ ...n, projects: n.projects.filter((p) => p.project === projectFilter) }))
      .filter((n) => n.projects.length > 0);
  }
  return nodes;
}

/* ── rendering ───────────────────────────────────────────────────────────── */

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
};

export interface RenderOpts {
  color?: boolean;
}

export function renderCatalogTree(nodes: SoftwareNode[], opts: RenderOpts = {}): string[] {
  const c = (code: string, s: string) => (opts.color ? `${code}${s}${ANSI.reset}` : s);
  const lines: string[] = [];

  if (!nodes.length) {
    lines.push("(catálogo vacío — corre `aitl init` o `aitl software add` + `aitl repo add` + `aitl branch sync`)");
    return lines;
  }

  for (const node of nodes) {
    const title = node.software
      ? `${c(ANSI.bold + ANSI.red, node.software.display_name || node.software.name)} ${c(ANSI.dim, "(software)")}`
      : c(ANSI.dim, "(sin software)");
    const desc = node.software?.description ? ` ${c(ANSI.dim, `— ${node.software.description}`)}` : "";
    lines.push(`◆ ${title}${desc}`);

    node.projects.forEach((p, pi) => {
      const lastP = pi === node.projects.length - 1;
      const pPrefix = lastP ? "└─" : "├─";
      const pIndent = lastP ? "   " : "│  ";
      lines.push(`${pPrefix} ${c(ANSI.bold + ANSI.magenta, p.project)} ${c(ANSI.dim, "(project)")}`);

      p.repos.forEach((r, ri) => {
        const lastR = ri === p.repos.length - 1;
        const rPrefix = `${pIndent}${lastR ? "└─" : "├─"}`;
        const rIndent = `${pIndent}${lastR ? "   " : "│  "}`;
        const remote = r.repo.remote ? ` ${c(ANSI.dim, r.repo.remote + (r.repo.branch ? `#${r.repo.branch}` : ""))}` : "";
        lines.push(`${rPrefix} ${c(ANSI.green, r.repo.name)} ${c(ANSI.dim, "(repo)")}${remote}`);

        r.branches.forEach((b, bi) => {
          const lastB = bi === r.branches.length - 1;
          const bPrefix = `${rIndent}${lastB ? "└─" : "├─"}`;
          const env = b.environment && b.environment !== "none" ? ` ${c(ANSI.yellow, `[${b.environment}]`)}` : "";
          const from = b.base ? ` ${c(ANSI.dim, `← ${b.base}`)}` : "";
          const lock = b.protectedBranch ? ` ${c(ANSI.dim, "⛨")}` : "";
          lines.push(
            `${bPrefix} ${c(ANSI.cyan, b.name)} ${c(ANSI.dim, `(${b.kind ?? "other"})`)}${env}${from}${lock}`,
          );
        });
        if (!r.branches.length) {
          lines.push(`${rIndent}${c(ANSI.dim, "└─ (sin ramas — `aitl branch sync`)")}`);
        }
      });
      if (!p.repos.length) {
        lines.push(`${pIndent}${c(ANSI.dim, "└─ (sin repos — `aitl repo add`)")}`);
      }
    });
    if (!node.projects.length) {
      lines.push(c(ANSI.dim, "└─ (sin projects)"));
    }
  }
  return lines;
}
