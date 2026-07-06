/**
 * `aitl init` — idempotent repo-onboarding orchestrator (P5/F1).
 *
 * One command that takes a fresh repo to "harness-ready": DB bootstrap, project
 * identity (software → project → repo → branches), master index (symbols + memory +
 * ADRs), seeds (skills + roles), guides (CLAUDE.md/AGENTS.md), `.mcp.json`, host
 * hooks (`.claude/settings.json`) and the git post-merge reindex hook.
 *
 * Every step is check-first: already-done work is reported as `skip`, so a second
 * run is a no-op. Nothing user-authored is ever clobbered without `--force` — JSON
 * and markdown merges are conservative (see `src/init/merge.ts`).
 *
 * Mongo-touching work goes through the injectable `InitServices` seam so the
 * orchestrator is unit-testable with fakes + a temp filesystem (no real DB).
 */

import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { DbInitReport } from "../db/init.js";
import { writeAgentGuide } from "./agent.js";
import { writeClaudeGuide } from "./claude.js";
import {
  type HookSpec,
  mergeClaudeSettings,
  mergeGuideSection,
  mergeMcpJson,
  mergePostMergeHook,
} from "./merge.js";

export type InitHost = "claude-code" | "codex";

export interface InitRepoOpts {
  /** Target repo root (absolute or cwd-relative). */
  root: string;
  /** Project scope (default: basename(root)). */
  project?: string;
  /** Hosts to wire hooks for (claude-code → .claude/settings.json; codex → AGENTS.md). */
  host?: InitHost[];
  /** Skip provider validation; memory pipeline only (run/chat need a backend or host). */
  memoryOnly?: boolean;
  /** Re-apply steps that would otherwise skip, and overwrite guides/post-merge. */
  force?: boolean;
  /** Owning software name (default: the project). */
  software?: string;
  /** Repo name — the data sub-scope (default: basename(root)). */
  repo?: string;
}

export type InitStatus = "ok" | "skip" | "done" | "warn";

export interface InitStepLine {
  status: InitStatus;
  step: string;
  detail: string;
}

export interface InitReport {
  project: string;
  software: string;
  repo: string;
  root: string;
  branch: string | null;
  memoryOnly: boolean;
  harnessRoot: string;
  steps: InitStepLine[];
  /** "Próximos pasos" block, ready to print. */
  next: string[];
}

/** Injectable seam for everything that touches Mongo (fakes in tests, real stores in prod). */
export interface InitServices {
  initDb(): Promise<DbInitReport>;
  getSoftware(name: string): Promise<Record<string, unknown> | null>;
  upsertSoftware(rec: Record<string, unknown> & { name: string; projects: string[] }): Promise<unknown>;
  getRepo(project: string, name: string): Promise<Record<string, unknown> | null>;
  upsertRepo(rec: {
    project: string;
    name: string;
    software: string | null;
    path: string;
    branch: string;
  }): Promise<unknown>;
  listBranches(project: string, repo: string): Promise<{ name: string }[]>;
  syncBranches(opts: { project: string; repo: string; root: string }): Promise<{ name: string }[]>;
  countSymbols(project: string, repo: string | null, branch: string | null): Promise<number>;
  indexRepo(opts: {
    project: string;
    root: string;
    repo: string | null;
    memoryDir?: string;
  }): Promise<{ symbols: number; steps: string[] }>;
  hasSkills(project: string, names: string[]): Promise<boolean>;
  seedSkills(project: string): Promise<string[]>;
  hasRoles(project: string, names: string[]): Promise<boolean>;
  seedRoles(project: string): Promise<string[]>;
  providerStatus(): { active: string | null; fallbacks: string[] };
  currentBranch(root: string): string | null;
}

// ── harness location (used by .mcp.json / hooks so they point at THIS install) ──

/**
 * Root of THIS harness installation: walk up from this module (src/init/… in dev,
 * dist/src/init/… when built) to the package.json named `aitl-mcp`. The generated
 * `.mcp.json` and hooks invoke the harness through `npm --prefix <root> run …`, so
 * they work from any cwd and load the harness's own .env (Mongo config included).
 */
export function resolveHarnessRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "aitl-mcp") return dir;
    } catch {
      // no package.json here — keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: assume <root>/src/init or <root>/dist/src/init layout.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Quote a shell argument only when it needs it (keeps generated commands readable). */
function shq(s: string): string {
  return /^[A-Za-z0-9_\-./:=]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `aitl …` invocation prefix that works without a global bin (npm run in the harness). */
export function aitlCommand(harnessRoot: string): string {
  return `npm --prefix ${shq(harnessRoot)} run --silent aitl --`;
}

// ── default (real) services ──────────────────────────────────────────────────

export async function makeInitServices(): Promise<InitServices> {
  const [{ initDb }, { SoftwareStore }, { RepoStore }, { BranchStore }, { syncBranches }, { providerStatus }, { currentBranch }] =
    await Promise.all([
      import("../db/init.js"),
      import("../softwares/store.js"),
      import("../repos/store.js"),
      import("../branches/store.js"),
      import("../branches/sync.js"),
      import("../providers/base.js"),
      import("../util/git.js"),
    ]);
  const softwares = new SoftwareStore();
  const repos = new RepoStore();
  const branches = new BranchStore();
  return {
    initDb,
    getSoftware: (name) => softwares.get(name) as Promise<Record<string, unknown> | null>,
    upsertSoftware: (rec) => softwares.upsert(rec as never),
    getRepo: (project, name) => repos.get(project, name) as Promise<Record<string, unknown> | null>,
    upsertRepo: (rec) => repos.upsert(rec),
    listBranches: (project, repo) => branches.list({ project, repo }),
    syncBranches: (opts) => syncBranches(opts),
    async countSymbols(project, repo, branch) {
      const { SymbolModel } = await import("../models/symbol.model.js");
      const { ensureMongoose } = await import("../db/mongoose.js");
      await ensureMongoose();
      return SymbolModel.countDocuments({ project, repo, ...(branch ? { branch } : {}) });
    },
    async indexRepo(opts) {
      const { indexRepo } = await import("../indexing/indexRepo.js");
      const r = await indexRepo({
        project: opts.project,
        root: opts.root,
        repo: opts.repo,
        ...(opts.memoryDir ? { memoryDir: opts.memoryDir } : {}),
      });
      return { symbols: r.symbols, steps: r.steps };
    },
    async hasSkills(project, names) {
      const { DefinitionStore } = await import("../projectctx/store.js");
      const store = new DefinitionStore("skill");
      const found = await Promise.all(names.map((n) => store.get(project, n)));
      return found.every((d) => d !== null);
    },
    async seedSkills(project) {
      const { seedMasterSkills } = await import("../builder/seed.js");
      return (await seedMasterSkills(project)).map((d) => d.name);
    },
    async hasRoles(project, names) {
      const { RoleStore } = await import("../roles/store.js");
      const have = new Set((await new RoleStore().list(project)).map((r) => r.name));
      return names.every((n) => have.has(n));
    },
    async seedRoles(project) {
      const { seedRoles } = await import("../roles/seed.js");
      const { RoleStore } = await import("../roles/store.js");
      return seedRoles(project, new RoleStore());
    },
    providerStatus() {
      const st = providerStatus();
      return { active: st.active, fallbacks: st.fallbacks };
    },
    currentBranch: (root) => currentBranch(root),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export const MASTER_SKILLS = ["definition-builder", "repo-indexer"] as const;
export const SEED_ROLE_NAMES = ["security", "devops", "qa", "architect", "devsecops"] as const;

// ── orchestrator ─────────────────────────────────────────────────────────────

export async function initRepo(opts: InitRepoOpts, services?: InitServices): Promise<InitReport> {
  const svc = services ?? (await makeInitServices());
  const root = resolve(opts.root);
  const project = opts.project?.trim() || basename(root);
  const software = opts.software?.trim() || project;
  const repo = opts.repo?.trim() || basename(root);
  const force = Boolean(opts.force);
  const memoryOnly = Boolean(opts.memoryOnly);
  const hosts = opts.host ?? [];
  const harnessRoot = resolveHarnessRoot();
  const aitl = aitlCommand(harnessRoot);

  const steps: InitStepLine[] = [];
  const add = (status: InitStatus, step: string, detail: string) => steps.push({ status, step, detail });

  if (!(await exists(root))) throw new Error(`init: el root '${root}' no existe.`);
  const branch = svc.currentBranch(root);

  // (a) DB — collections + indexes + first-root bootstrap (idempotent by construction).
  const db = await svc.initDb();
  add("ok", "db", `colecciones/índices listos (${db.collections.length} colecciones)`);
  if (!db.vector.ok) add("warn", "db-vector", `índices vectoriales no disponibles (${(db.vector.error ?? "").slice(0, 120)}) — fallback texto/recencia activo`);
  add(
    db.bootstrap.status === "created" ? "done" : "ok",
    "db-root",
    db.bootstrap.status === "created"
      ? `root bootstrap creado (${db.bootstrap.username})${db.bootstrap.generated && db.bootstrap.password ? ` — password generado: ${db.bootstrap.password} (se muestra UNA vez)` : ""}`
      : db.bootstrap.status === "exists"
        ? `usuario root ya existe (${db.bootstrap.username})`
        : `bootstrap omitido: ${db.bootstrap.reason ?? "ya hay usuarios"}`,
  );

  // Provider validation — skipped entirely in memory mode (i).
  if (memoryOnly) {
    add("skip", "provider", "modo memoria (--memory-only): validación de backend omitida");
  } else {
    const st = svc.providerStatus();
    if (st.active) {
      add("ok", "provider", `backend activo: ${st.active}${st.fallbacks.length ? ` (fallback: ${st.fallbacks.join(" → ")})` : ""}`);
    } else {
      add("warn", "provider", "sin backend de modelo — run/chat no funcionarán; usa --memory-only, configura AITL_API_KEY/LMSTUDIO_*, o delega a un host (aitl run-host)");
    }
  }

  // (b) Identity: software → project → repo → branch catalog.
  const sw = await svc.getSoftware(software);
  const swProjects = Array.isArray(sw?.projects) ? (sw.projects as string[]) : [];
  if (sw && swProjects.includes(project) && !force) {
    add("skip", "software", `'${software}' ya registra el proyecto '${project}'`);
  } else {
    const { _id: _ignored, ...swRest } = (sw ?? {}) as Record<string, unknown>;
    await svc.upsertSoftware({
      ...swRest,
      name: software,
      projects: [...new Set([...swProjects, project])],
    });
    add("done", "software", sw ? `proyecto '${project}' añadido a '${software}'` : `software '${software}' creado con proyecto '${project}'`);
  }

  const existingRepo = await svc.getRepo(project, repo);
  if (existingRepo && !force) {
    add("skip", "repo", `'${project}/${repo}' ya registrado`);
  } else {
    await svc.upsertRepo({ project, name: repo, software, path: root, branch: branch ?? "" });
    add("done", "repo", `repo '${repo}' registrado en '${project}' (path ${root})`);
  }

  const knownBranches = await svc.listBranches(project, repo);
  if (knownBranches.length && !force) {
    add("skip", "branches", `catálogo ya tiene ${knownBranches.length} rama(s)`);
  } else {
    const synced = await svc.syncBranches({ project, repo, root });
    add(synced.length ? "done" : "warn", "branches", synced.length ? `${synced.length} rama(s) sincronizada(s)` : "sin ramas git locales (¿es un repo git?)");
  }

  // (c) Master index: skip when symbols for (project, repo, branch) already exist.
  const symbolCount = await svc.countSymbols(project, repo, branch);
  if (symbolCount > 0 && !force) {
    add("skip", "index", `ya hay ${symbolCount} símbolos para ${project}/${repo}${branch ? `@${branch}` : ""} (usa --force para reindexar)`);
  } else {
    const memoryDir = join(root, ".aitl", "memory");
    const idx = await svc.indexRepo({
      project,
      root,
      repo,
      ...((await exists(memoryDir)) ? { memoryDir } : {}),
    });
    add("done", "index", idx.steps.join(" · ") || `${idx.symbols} símbolos`);
  }

  // (d) Seeds: master skills + engineering roles (both upserts; skip when complete).
  if ((await svc.hasSkills(project, [...MASTER_SKILLS])) && !force) {
    add("skip", "seed-skills", `skills maestras ya presentes (${MASTER_SKILLS.join(", ")})`);
  } else {
    add("done", "seed-skills", `skills maestras: ${(await svc.seedSkills(project)).join(", ")}`);
  }
  if ((await svc.hasRoles(project, [...SEED_ROLE_NAMES])) && !force) {
    add("skip", "seed-roles", `roles ya presentes (${SEED_ROLE_NAMES.join(", ")})`);
  } else {
    add("done", "seed-roles", `roles: ${(await svc.seedRoles(project)).join(", ")}`);
  }

  // (e) Guides: create when missing; --force overwrites; else minimal AITL-section merge.
  const guides: { file: string; write: (out: string, force: boolean) => Promise<string> }[] = [
    { file: "CLAUDE.md", write: (out, f) => writeClaudeGuide({ out, project, mcp: "aitl-js", force: f }) },
    { file: "AGENTS.md", write: (out, f) => writeAgentGuide({ out, project, mcp: "aitl-js", force: f }) },
  ];
  for (const g of guides) {
    const out = join(root, g.file);
    const current = await readIfExists(out);
    if (current === null || force) {
      await g.write(out, force);
      add("done", g.file, current === null ? "creado" : "sobrescrito (--force)");
    } else {
      const merged = mergeGuideSection(current, project);
      if (merged.changed) await fs.writeFile(out, merged.content, "utf8");
      add(merged.changed ? "done" : "skip", g.file, merged.reason);
    }
  }

  // (f) .mcp.json → this harness install via `npm --prefix` (no global bin required).
  const mcpPath = join(root, ".mcp.json");
  const mcpEntry = { command: "npm", args: ["--prefix", harnessRoot, "run", "mcp", "--silent"] };
  try {
    const merged = mergeMcpJson(await readIfExists(mcpPath), "aitl-js", mcpEntry);
    if (merged.changed) await fs.writeFile(mcpPath, merged.content, "utf8");
    add(merged.changed ? "done" : "skip", ".mcp.json", `${merged.reason} (harness: ${harnessRoot})`);
  } catch (err) {
    add("warn", ".mcp.json", err instanceof Error ? err.message : String(err));
  }

  // (g) Host hooks.
  if (hosts.includes("claude-code")) {
    const settingsPath = join(root, ".claude", "settings.json");
    const specs: HookSpec[] = [
      { event: "UserPromptSubmit", command: `${aitl} hydrate --project ${shq(project)} --no-vector`, marker: "hydrate" },
      { event: "Stop", command: `${aitl} capture-session --project ${shq(project)}`, marker: "capture-session" },
    ];
    try {
      const merged = mergeClaudeSettings(await readIfExists(settingsPath), specs);
      if (merged.changed) {
        await fs.mkdir(dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, merged.content, "utf8");
      }
      add(merged.changed ? "done" : "skip", "hooks-claude", merged.reason);
    } catch (err) {
      add("warn", "hooks-claude", err instanceof Error ? err.message : String(err));
    }
  }
  if (hosts.includes("codex")) {
    // Codex has no hook system: its contract is AGENTS.md (already ensured in (e)).
    add("ok", "host-codex", "AGENTS.md cubre el contrato (Codex no soporta hooks nativos)");
  }
  if (!hosts.length) {
    add("ok", "hooks", "sin --host: solo guías (añade --host claude-code para hooks de hydrate/captura)");
  }

  // (h) git post-merge → branch sync --reindex (best-effort, `|| true` never breaks a merge).
  const gitDir = join(root, ".git");
  if (await exists(gitDir)) {
    const hookPath = join(gitDir, "hooks", "post-merge");
    const line = `${aitl} branch sync --reindex --project ${shq(project)} --repo ${shq(repo)} --root "$(git rev-parse --show-toplevel)" || true`;
    const current = await readIfExists(hookPath);
    const merged = mergePostMergeHook(force ? null : current, line);
    if (merged.changed || (force && current !== null)) {
      await fs.mkdir(dirname(hookPath), { recursive: true });
      await fs.writeFile(hookPath, merged.content, "utf8");
      await fs.chmod(hookPath, 0o755);
      add("done", "post-merge", current === null ? merged.reason : force ? "hook reescrito (--force)" : merged.reason);
    } else {
      add("skip", "post-merge", merged.reason);
    }
  } else {
    add("warn", "post-merge", `'${root}' no es un repo git (.git ausente) — hook omitido`);
  }

  // (j) Next steps.
  const next = [
    `1. Usuario: aitl user register --username <u> --email <e> --password <pw>  (o regístrate en la UI)`,
    `2. Explora la memoria: aitl ui --project ${project}`,
    `3. Espejo markdown:    aitl sync --project ${project}`,
    `4. Corre el agente:    C2 (harness completo): aitl run "<tarea>" --project ${project}`,
    `                       C0 (baseline):         aitl run "<tarea>" --project ${project} --bare`,
  ];
  if (memoryOnly) {
    next.push(
      "modo memoria: hydrate/search/sync/capture operativos; run/chat requieren backend (AITL_API_KEY / LMSTUDIO_*) o host (aitl run-host --host claude-code)",
    );
  }

  return { project, software, repo, root, branch, memoryOnly, harnessRoot, steps, next };
}
