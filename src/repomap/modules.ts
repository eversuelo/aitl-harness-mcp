/**
 * Module map + module brief over the cached repo map (P6).
 *
 * `buildModuleMap` aggregates the live `symbols` collection (same project/repo filter
 * as `RepoMap.render`, ADR-0037 branch-aware staleness warning included) by FIRST-LEVEL
 * directory relative to the repo root; loose root files land in a synthetic "(root)"
 * module. When ONE top-level dir holds >80% of the files (the everything-under-`src/`
 * layout) the map descends ONE level into it (`src/server`, `src/db`, …) so the result
 * stays useful — a single `src` row tells you nothing.
 *
 * `classifyModuleKind` is a PURE heuristic (extension + path-name signals) with a
 * declarative override: `.aitl/modules.json` `{ "<dir>": "view"|"back"|"mixed"|"infra" }`
 * always wins.
 *
 * `buildModuleBrief` is the TODO.md "module-brief": for one dir it renders (a) its
 * module-map block, (b) the ACTIVE ADRs whose `components[]` intersect the dir
 * (prefix match both ways; deprecated/superseded excluded via INACTIVE_ADR_STATUSES),
 * and (c) the memories tagged `component:<dir>` (same matching). Persistence is behind
 * an injectable deps seam so tests run against in-memory fakes.
 */

import { promises as fs } from "node:fs";
import { extname, join } from "node:path";
import { INACTIVE_ADR_STATUSES } from "../decisions/lifecycle.js";
import { ensureMongoose } from "../db/mongoose.js";
import { DecisionModel } from "../models/decision.model.js";
import { MemoryModel } from "../models/memory.model.js";
import { SymbolModel } from "../models/symbol.model.js";
import { currentBranch } from "../util/git.js";

export type ModuleKind = "view" | "back" | "mixed" | "infra";

export const MODULE_KINDS: readonly ModuleKind[] = ["view", "back", "mixed", "infra"];

/** Module name for loose files at the repo root (configs, entry points). */
export const ROOT_MODULE = "(root)";

/** Share of view-vs-back file signals one side needs to win outright (else "mixed"). */
export const KIND_DECISION_RATIO = 0.7;

/** Share of all files one top-level dir must hold for the map to descend one level into it. */
export const DESCEND_DOMINANCE_RATIO = 0.8;

// ── classification heuristics (pure) ─────────────────────────────────────────

const VIEW_EXTS = new Set([".tsx", ".jsx", ".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte"]);
const VIEW_DIR_NAMES = new Set(["web", "ui", "frontend", "views", "components", "pages", "client"]);
const BACK_DIR_NAMES = new Set(["server", "db", "database", "models", "api", "backend", "routes", "controllers"]);
// Only checked against the MODULE dir's first segment (a `src/config` code dir is not infra).
const INFRA_TOP_DIR_NAMES = new Set(["scripts", "docs", "ci", "infra", "deploy", "config", "configs", "build", "tools"]);

/** POSIX-normalize a path-ish key: forward slashes, no leading `./`, no trailing `/`. */
function normPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");
}

/** Directory segments of a file path (filename excluded), lowercased. */
function dirSegments(file: string): string[] {
  const segs = normPath(file).split("/").filter(Boolean);
  return segs.slice(0, -1).map((s) => s.toLowerCase());
}

/**
 * Classify a module dir from its files. Pure: no I/O — pass `.aitl/modules.json`
 * overrides in (they always win). Signals:
 *   - view: view extension (.tsx/.jsx/.css/.html/.vue/.svelte/…) or a view-named
 *     path segment (web/ ui/ frontend/ views/ components/ pages/ client/);
 *   - back: a back-named path segment (server/ db/ models/ api/ backend/ …);
 *   - infra: the module IS "(root)" or its first segment is an infra dir
 *     (scripts/ docs/ ci/ …) or a dot-dir (.github/ .aitl/ …).
 * With signals on both sides, a side needs >=70% of the signal-carrying files to win;
 * otherwise "mixed". No signals at all → the module dir's own name votes, else "back"
 * (plain non-UI code is the common case).
 */
export function classifyModuleKind(
  dir: string,
  files: string[],
  overrides: Record<string, ModuleKind> = {},
): ModuleKind {
  const d = normPath(dir);
  for (const [key, kind] of Object.entries(overrides)) {
    if (normPath(key) === d && (MODULE_KINDS as readonly string[]).includes(kind)) return kind;
  }

  if (d === ROOT_MODULE) return "infra"; // loose root files: configs, manifests
  const ownSegs = d.split("/").filter(Boolean).map((s) => s.toLowerCase());
  const top = ownSegs[0] ?? "";
  if (INFRA_TOP_DIR_NAMES.has(top) || top.startsWith(".")) return "infra";

  let view = 0;
  let back = 0;
  for (const f of files) {
    const segs = dirSegments(f);
    const isView = VIEW_EXTS.has(extname(f).toLowerCase()) || segs.some((s) => VIEW_DIR_NAMES.has(s));
    const isBack = segs.some((s) => BACK_DIR_NAMES.has(s));
    if (isView) view++;
    if (isBack) back++;
  }

  if (view + back === 0) {
    // No file signals: the module dir's own name is the only evidence left.
    const dirView = ownSegs.some((s) => VIEW_DIR_NAMES.has(s));
    const dirBack = ownSegs.some((s) => BACK_DIR_NAMES.has(s));
    if (dirView && dirBack) return "mixed";
    if (dirView) return "view";
    return "back";
  }
  const total = view + back;
  if (view / total >= KIND_DECISION_RATIO) return "view";
  if (back / total >= KIND_DECISION_RATIO) return "back";
  return "mixed";
}

/** Load `.aitl/modules.json` overrides from `root`; `{}` when missing/invalid (never throws). */
export async function loadModuleOverrides(root: string): Promise<Record<string, ModuleKind>> {
  try {
    const raw = await fs.readFile(join(root, ".aitl", "modules.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ModuleKind> = {};
    for (const [dir, kind] of Object.entries(parsed)) {
      if (typeof kind === "string" && (MODULE_KINDS as readonly string[]).includes(kind)) {
        out[dir] = kind as ModuleKind;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── module map (aggregation over `symbols`) ───────────────────────────────────

export interface TopSymbol {
  name: string;
  file: string;
  pagerank: number;
}

export interface ModuleEntry {
  module: string;
  kind: ModuleKind;
  /** Distinct files in the module (sorted). */
  files: string[];
  /** Symbol (definition) count in the module. */
  symbols: number;
  /** Top 5 symbols by PageRank. */
  topSymbols: TopSymbol[];
}

export interface ModuleMap {
  project: string;
  repo: string | null;
  /** Branch the stored symbol snapshot was built for (ADR-0037). */
  branch: string | null;
  /** True when the snapshot branch differs from the live working-tree branch. */
  stale: boolean;
  /** Top-level dir the map descended one level into (null = plain first-level grouping). */
  descendedInto: string | null;
  modules: ModuleEntry[];
}

export interface ModuleMapOpts {
  repo?: string;
  /** Filter symbols to one snapshot branch (default: same as render — no filter, warn on staleness). */
  branch?: string;
  /** Repo root used to load `.aitl/modules.json` (default: process.cwd()). */
  root?: string;
  /** Explicit overrides (skips reading `.aitl/modules.json`). */
  overrides?: Record<string, ModuleKind>;
  /** Set false to disable the one-level descent into a dominant top-level dir. */
  descend?: boolean;
}

/** Minimal symbol row the aggregation needs (tests feed plain objects). */
export interface SymbolRow {
  file: string;
  name: string;
  pagerank?: number | null;
  branch?: string | null;
}

/** First-level module of a repo-root-relative file ("(root)" for loose root files). */
function topLevelModule(file: string): string {
  const segs = normPath(file).split("/").filter(Boolean);
  return segs.length > 1 ? segs[0] : ROOT_MODULE;
}

/** Module of `file` after descending one level into `dominant` (loose files keep the dir itself). */
function descendedModule(file: string, dominant: string): string {
  const segs = normPath(file).split("/").filter(Boolean);
  if (segs[0] !== dominant) return topLevelModule(file);
  return segs.length > 2 ? `${dominant}/${segs[1]}` : dominant;
}

/**
 * Pure aggregation core: group symbol rows into a module map. Exposed for tests;
 * `buildModuleMap` is the DB-backed wrapper.
 */
export function aggregateModules(
  rows: SymbolRow[],
  overrides: Record<string, ModuleKind> = {},
  opts: { descend?: boolean } = {},
): { modules: ModuleEntry[]; descendedInto: string | null } {
  // Pass 1: distinct files per top-level module, to decide the descent.
  const filesByTop = new Map<string, Set<string>>();
  const allFiles = new Set<string>();
  for (const r of rows) {
    const file = normPath(r.file);
    if (!file) continue;
    allFiles.add(file);
    const top = topLevelModule(file);
    (filesByTop.get(top) ?? filesByTop.set(top, new Set()).get(top)!).add(file);
  }
  let descendedInto: string | null = null;
  if (opts.descend !== false && allFiles.size > 0) {
    for (const [top, files] of filesByTop) {
      if (top === ROOT_MODULE) continue;
      if (files.size / allFiles.size > DESCEND_DOMINANCE_RATIO) {
        // Only worth splitting when the dir actually has subdirs.
        const hasSubdirs = [...files].some((f) => f.split("/").length > 2);
        if (hasSubdirs) descendedInto = top;
        break;
      }
    }
  }

  // Pass 2: aggregate per final module.
  const byModule = new Map<string, { files: Set<string>; symbols: number; top: TopSymbol[] }>();
  for (const r of rows) {
    const file = normPath(r.file);
    if (!file) continue;
    const module = descendedInto ? descendedModule(file, descendedInto) : topLevelModule(file);
    const entry = byModule.get(module) ?? { files: new Set<string>(), symbols: 0, top: [] };
    entry.files.add(file);
    entry.symbols += 1;
    entry.top.push({ name: r.name, file, pagerank: (r.pagerank as number) ?? 0 });
    byModule.set(module, entry);
  }

  const modules: ModuleEntry[] = [...byModule.entries()]
    .map(([module, e]) => {
      const files = [...e.files].sort();
      return {
        module,
        kind: classifyModuleKind(module, files, overrides),
        files,
        symbols: e.symbols,
        topSymbols: e.top
          .sort((a, b) => b.pagerank - a.pagerank || a.name.localeCompare(b.name))
          .slice(0, 5),
      };
    })
    .sort((a, b) => b.symbols - a.symbols || a.module.localeCompare(b.module));
  return { modules, descendedInto };
}

/**
 * Build the module map from the live `symbols` collection (same project/repo filter
 * and branch-staleness warning as `RepoMap.render`).
 */
export async function buildModuleMap(project: string, opts: ModuleMapOpts = {}): Promise<ModuleMap> {
  await ensureMongoose();
  const query: Record<string, unknown> = { project };
  if (opts.repo !== undefined) query.repo = opts.repo;
  if (opts.branch !== undefined) query.branch = opts.branch;
  const rows = (await SymbolModel.find(query, { file: 1, name: 1, pagerank: 1, branch: 1 }).lean()) as unknown as SymbolRow[];

  const storedBranch = rows[0]?.branch ?? null;
  const liveBranch = currentBranch();
  const stale = rows.length > 0 && storedBranch !== liveBranch;
  if (stale) {
    console.error(
      `[repomap] stale: symbols are for branch ${storedBranch}, current is ${liveBranch} — run 'aitl index-repo'`,
    );
  }

  const overrides = opts.overrides ?? (await loadModuleOverrides(opts.root ?? process.cwd()));
  const { modules, descendedInto } = aggregateModules(rows, overrides, { descend: opts.descend });
  return { project, repo: opts.repo ?? null, branch: storedBranch, stale, descendedInto, modules };
}

/** Compact text table of the module map for the CLI / MCP. */
export function renderModuleMap(map: ModuleMap): string {
  if (!map.modules.length) return "(module map empty — run 'aitl repomap --root .' or 'aitl index-repo' first)";
  const header = ["module", "kind", "files", "symbols", "top symbols"];
  const rows = map.modules.map((m) => [
    m.module,
    m.kind,
    String(m.files.length),
    String(m.symbols),
    m.topSymbols.map((t) => t.name).join(", "),
  ]);
  const w = (i: number) => Math.max(header[i].length, ...rows.map((r) => r[i].length));
  const widths = [w(0), w(1), w(2), w(3)];
  const line = (r: string[]) =>
    `${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padStart(widths[2])}  ${r[3].padStart(widths[3])}  ${r[4]}`;
  const out = [
    `Module map — project '${map.project}'${map.repo ? ` repo '${map.repo}'` : ""}${map.branch ? ` @${map.branch}` : ""} (${map.modules.length} modules)`,
  ];
  if (map.descendedInto) {
    out.push(`(descended one level into '${map.descendedInto}/' — it holds >${Math.round(DESCEND_DOMINANCE_RATIO * 100)}% of the files)`);
  }
  out.push("", line(header), line(widths.map((n) => "-".repeat(n)).concat("-".repeat(header[4].length))));
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

// ── component ↔ dir matching (shared by ADRs and memory tags) ────────────────

/** Tag prefix capture-session uses for the dirs a session touched (`component:src/server`). */
export const COMPONENT_TAG_PREFIX = "component:";

/**
 * True when an ADR `components[]` entry (or a `component:` tag value) concerns `dir`:
 * exact match, the component is an ancestor of the dir (`src` ⊇ `src/server`), or the
 * component is a subdir of the dir (`src/server/routes` ⊆ `src/server`). Matching is on
 * whole path segments — `src/serverx` never matches `src/server`.
 */
export function componentMatchesDir(component: string, dir: string): boolean {
  const c = normPath(component).toLowerCase();
  const d = normPath(dir).toLowerCase();
  if (!c || !d) return false;
  return c === d || d.startsWith(`${c}/`) || c.startsWith(`${d}/`);
}

// ── module brief ──────────────────────────────────────────────────────────────

export interface ModuleBriefAdr {
  id: string;
  title: string;
  status: string;
  components: string[];
  /** First line of the ADR's decision — the invariant, reduced. */
  decision: string;
}

export interface ModuleBriefMemory {
  slug: string;
  type: string;
  description: string;
  tags: string[];
}

export interface ModuleBrief {
  project: string;
  dir: string;
  repo: string | null;
  /** Matching module-map blocks (exact module preferred; else ancestors/descendants). */
  modules: ModuleEntry[];
  adrs: ModuleBriefAdr[];
  memories: ModuleBriefMemory[];
}

/** Injectable persistence seam (tests stub these; production reads the real models). */
export interface ModuleBriefDeps {
  loadModuleMap: (project: string, opts: ModuleMapOpts) => Promise<ModuleMap>;
  listDecisions: (project: string) => Promise<Record<string, unknown>[]>;
  /** Memories carrying at least one `component:` tag. */
  listComponentMemories: (project: string) => Promise<Record<string, unknown>[]>;
}

const defaultBriefDeps: ModuleBriefDeps = {
  loadModuleMap: buildModuleMap,
  listDecisions: async (project) => {
    await ensureMongoose();
    return (await DecisionModel.find({ project }, { embedding: 0 }).sort({ id: 1 }).lean()) as unknown as Record<
      string,
      unknown
    >[];
  },
  listComponentMemories: async (project) => {
    await ensureMongoose();
    return (await MemoryModel.find(
      { project, tags: { $elemMatch: { $regex: `^${COMPONENT_TAG_PREFIX}` } } },
      { embedding: 0, body: 0 },
    )
      .sort({ updated_at: -1 })
      .lean()) as unknown as Record<string, unknown>[];
  },
};

export interface ModuleBriefOpts {
  project: string;
  dir: string;
  repo?: string;
  /** Repo root for `.aitl/modules.json` (default: process.cwd()). */
  root?: string;
}

/**
 * Assemble the module brief for one dir: module-map block + ACTIVE ADRs whose
 * `components[]` match the dir + memories tagged `component:<dir>` (both matched
 * by `componentMatchesDir`). Deprecated/superseded ADRs are excluded.
 */
export async function buildModuleBrief(opts: ModuleBriefOpts, deps: Partial<ModuleBriefDeps> = {}): Promise<ModuleBrief> {
  const { loadModuleMap, listDecisions, listComponentMemories } = { ...defaultBriefDeps, ...deps };
  const mapOpts: ModuleMapOpts = {
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.root !== undefined ? { root: opts.root } : {}),
  };
  const [map, decisions, memories] = await Promise.all([
    loadModuleMap(opts.project, mapOpts),
    listDecisions(opts.project),
    listComponentMemories(opts.project),
  ]);

  const dir = normPath(opts.dir);
  const exact = map.modules.filter((m) => normPath(m.module).toLowerCase() === dir.toLowerCase());
  const modules = exact.length ? exact : map.modules.filter((m) => componentMatchesDir(m.module, dir));

  const adrs: ModuleBriefAdr[] = decisions
    .filter((d) => !INACTIVE_ADR_STATUSES.has(String(d.status ?? "")))
    .filter((d) => (Array.isArray(d.components) ? d.components : []).some((c) => componentMatchesDir(String(c), dir)))
    .map((d) => ({
      id: String(d.id ?? ""),
      title: String(d.title ?? ""),
      status: String(d.status ?? ""),
      components: (Array.isArray(d.components) ? d.components : []).map(String),
      decision: String(d.decision ?? "").split("\n")[0].trim(),
    }));

  const mems: ModuleBriefMemory[] = memories
    .filter((m) =>
      (Array.isArray(m.tags) ? m.tags : []).some(
        (t) => String(t).startsWith(COMPONENT_TAG_PREFIX) && componentMatchesDir(String(t).slice(COMPONENT_TAG_PREFIX.length), dir),
      ),
    )
    .map((m) => ({
      slug: String(m.slug ?? ""),
      type: String(m.type ?? ""),
      description: String(m.description ?? ""),
      tags: (Array.isArray(m.tags) ? m.tags : []).map(String),
    }));

  return { project: opts.project, dir, repo: opts.repo ?? null, modules, adrs, memories: mems };
}

/** Human-readable module brief: module block + ADR-invariant checklist + tagged memories. */
export function renderModuleBrief(brief: ModuleBrief): string {
  const out: string[] = [`# Module brief — ${brief.dir} (project '${brief.project}'${brief.repo ? `, repo '${brief.repo}'` : ""})`, ""];

  if (brief.modules.length) {
    for (const m of brief.modules) {
      out.push(`## ${m.module} — ${m.kind} · ${m.files.length} files · ${m.symbols} symbols`);
      for (const t of m.topSymbols) out.push(`  - ${t.name}  (${t.file})`);
      out.push("");
    }
  } else {
    out.push(`(no symbols for '${brief.dir}' in the cached repo map — build it with 'aitl repomap --root .' or 'aitl index-repo')`, "");
  }

  out.push(`## Invariantes de ${brief.dir} (ADRs con components — NO romper sin nueva ADR)`);
  if (brief.adrs.length) {
    for (const a of brief.adrs) {
      out.push(`- [ADR-${a.id}] ${a.title} (${a.status})${a.decision ? ` — ${a.decision}` : ""}`);
    }
  } else {
    out.push(
      `  (sin ADRs etiquetados con components que matcheen '${brief.dir}' — etiqueta las decisiones del módulo vía record_decision { components: ["${brief.dir}"] })`,
    );
  }
  out.push("");

  out.push(`## Memoria del módulo (tags ${COMPONENT_TAG_PREFIX}${brief.dir})`);
  if (brief.memories.length) {
    for (const m of brief.memories) {
      out.push(`- ${m.slug}${m.type ? ` [${m.type}]` : ""}${m.description ? ` — ${m.description}` : ""}`);
    }
  } else {
    out.push(
      `  (sin memorias con tag ${COMPONENT_TAG_PREFIX}… para '${brief.dir}' — capture-session las etiqueta al cerrar sesión, o añade tags ["${COMPONENT_TAG_PREFIX}${brief.dir}"] vía write_memory)`,
    );
  }
  return out.join("\n");
}
