/**
 * ADR regression guard — Layer 3 (TODO.md §3, closes the anti-regression pipeline).
 *
 * A **PostToolHook** that fires after `write_file`, `edit_file`, or `shell` tools.
 * It resolves the affected file path → component dir → active ADRs via
 * `componentMatchesDir`, and **appends a structured reminder** to the tool result
 * so the model sees the relevant architectural invariants BEFORE its next reasoning
 * step.
 *
 * Design choices:
 *   - **Post-hook, not pre-hook**: we annotate the result (rules-first reminder), we
 *     don't block. A pre-hook that blocks would need an LLM call to judge
 *     contradiction, which is expensive and slow — deferred to a later LLM-mode gate.
 *   - **Deterministic**: tag-based match via `componentMatchesDir`, no LLM needed.
 *   - **Idempotent install**: `installAdrGuard` tracks installed registries so
 *     multi-turn chat never stacks duplicate hooks.
 *   - **Best-effort**: if Mongo is down or components are empty, the hook is a no-op.
 *
 * The guard also exports a standalone `checkPathAgainstAdrs` for use in pre-commit
 * hooks or the `aitl guard` CLI command.
 */

import { dirname, isAbsolute, relative, sep } from "node:path";
import type { ADR } from "../models/decision.model.js";
import { INACTIVE_ADR_STATUSES } from "../decisions/lifecycle.js";
import { componentMatchesDir } from "../repomap/modules.js";
import type { PostToolHook, ToolRegistry } from "../tools/base.js";

// ── types ────────────────────────────────────────────────────────────────────

export interface AdrGuardWarning {
  adrId: string;
  title: string;
  decision: string;
  components: string[];
}

export interface AdrGuardResult {
  /** File path that triggered the guard (relative to repo root). */
  path: string;
  /** Component dir the path resolved to. */
  dir: string;
  /** Active ADRs whose `components[]` match the dir. */
  adrs: AdrGuardWarning[];
}

// ── pure core: path → component dir → ADRs ──────────────────────────────────

/** Resolve a file path to its parent directory (the "component dir" for matching).
 *  Normalises to forward-slash POSIX style, strips leading `./`, and returns the
 *  first meaningful ancestor (i.e. `src/server/routes/api.ts` → `src/server/routes`). */
export function pathToComponentDir(filePath: string): string {
  // Normalise backslashes BEFORE dirname — on Linux, dirname("a\\b") returns "."
  const normalised = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const dir = dirname(normalised);
  return dir === "." ? "" : dir;
}

/**
 * Pure, dependency-free check: given a file path and a list of active ADRs,
 * returns the ADRs whose `components[]` overlap with the file's dir.
 */
export function checkPathAgainstAdrs(filePath: string, adrs: readonly ADR[]): AdrGuardResult {
  const dir = pathToComponentDir(filePath);
  if (!dir) return { path: filePath, dir, adrs: [] };

  const matched: AdrGuardWarning[] = [];
  for (const adr of adrs) {
    if (INACTIVE_ADR_STATUSES.has(String(adr.status ?? ""))) continue;
    const comps = Array.isArray(adr.components) ? adr.components : [];
    if (comps.length === 0) continue;
    if (comps.some((c) => componentMatchesDir(String(c), dir))) {
      matched.push({
        adrId: String(adr.id),
        title: String(adr.title),
        decision: String(adr.decision ?? "").split("\n")[0].trim(),
        components: comps.map(String),
      });
    }
  }
  return { path: filePath, dir, adrs: matched };
}

/**
 * Render a guard result as a compact text block suitable for appending to a tool
 * result.  Returns an empty string when no ADRs match (no-op).
 */
export function renderGuardWarning(results: AdrGuardResult[]): string {
  const hits = results.filter((r) => r.adrs.length > 0);
  if (hits.length === 0) return "";

  const lines: string[] = [
    "",
    "⚠ ADR regression guard — DO NOT break these architectural decisions:",
  ];
  for (const r of hits) {
    for (const a of r.adrs) {
      lines.push(`  [ADR-${a.adrId}] ${a.title}`);
      if (a.decision) lines.push(`    → ${a.decision}`);
    }
  }
  lines.push("  If your change intentionally supersedes an ADR, record a new ADR first.");
  return lines.join("\n");
}

// ── hook factory ─────────────────────────────────────────────────────────────

/** Names of tools whose result we annotate with ADR reminders. */
const GUARDED_TOOLS = new Set(["write_file", "edit_file", "shell"]);

export interface AdrGuardOpts {
  project: string;
  /** Repo root used to turn absolute paths into relative component dirs.
   *  Default: `process.cwd()`. */
  root?: string;
  /** Override for testing: provide ADRs directly instead of querying Mongo. */
  loadAdrs?: (project: string) => Promise<readonly ADR[]>;
}

/** Cache for the loaded ADRs — refreshed on a timer so the hook stays fast. */
interface AdrCache {
  adrs: readonly ADR[];
  ts: number;
}

const CACHE_TTL_MS = 30_000; // 30s — fresh enough for interactive use

/**
 * Build the PostToolHook that annotates write/edit results with ADR reminders.
 * The hook is async-safe and never throws (post-hooks that throw are silently
 * swallowed by the registry, so we catch internally and log to stderr).
 */
export function adrGuardHook(opts: AdrGuardOpts): PostToolHook {
  const root = opts.root ?? process.cwd();
  let cache: AdrCache | null = null;

  const getAdrs = async (): Promise<readonly ADR[]> => {
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.adrs;
    try {
      if (opts.loadAdrs) {
        const adrs = await opts.loadAdrs(opts.project);
        cache = { adrs, ts: Date.now() };
        return adrs;
      }
      // Production path: dynamic import so the module doesn't hard-depend on Mongoose.
      const { ensureMongoose } = await import("../db/mongoose.js");
      const { DecisionModel } = await import("../models/decision.model.js");
      await ensureMongoose();
      const docs = (await DecisionModel.find(
        { project: opts.project },
        { embedding: 0, context: 0, consequences: 0, deprecation_reason: 0 },
      )
        .sort({ id: 1 })
        .lean()) as unknown as ADR[];
      cache = { adrs: docs, ts: Date.now() };
      return docs;
    } catch {
      // Mongo down / not configured — degrade silently.
      return cache?.adrs ?? [];
    }
  };

  return async (name, args, result) => {
    if (!GUARDED_TOOLS.has(name)) return;

    // Resolve the file path from the tool args.
    let filePath = String(args.path ?? args.command ?? "");
    if (!filePath) return;

    // For `shell`, try to extract a likely target path from the command.
    // This is best-effort — we skip if we can't identify a clear file target.
    if (name === "shell") {
      // Shell commands don't have a single "path"; skip for now unless
      // we later parse git diff from the output.
      return;
    }

    // Convert absolute path to relative (component dir matching is repo-relative).
    if (isAbsolute(filePath)) {
      filePath = relative(root, filePath).split(sep).join("/");
    }

    const adrs = await getAdrs();
    if (adrs.length === 0) return;

    const check = checkPathAgainstAdrs(filePath, adrs);
    const warning = renderGuardWarning([check]);
    if (!warning) return;

    return { result: result + warning };
  };
}

// ── idempotent installer ─────────────────────────────────────────────────────

const _installed = new WeakSet<ToolRegistry>();

/**
 * Install the ADR regression guard hook on a registry. Idempotent: calling
 * twice with the same registry is a no-op.
 */
export function installAdrGuard(registry: ToolRegistry, opts: AdrGuardOpts): void {
  if (_installed.has(registry)) return;
  _installed.add(registry);
  registry.addPostHook(adrGuardHook(opts));
}
