/**
 * Canonical project-key resolution — closes the ADR-0055 trap.
 *
 * Several commands used to fall back to the cwd's basename (`AITL-Harness-JS`) when
 * `--project` was omitted; if that differs from the canonical key (`aitl-js`) they
 * silently operate on an EMPTY Mongo scope and "see nothing". The durable fix is a
 * repo-local marker written by `aitl init`: `.aitl/project.json` → `{"project": "<key>"}`.
 *
 * Precedence (highest wins):
 *   1. explicit `--project` flag
 *   2. `$AITL_PROJECT`
 *   3. `.aitl/project.json`, walking UP from cwd (subdirectories resolve to the repo's key)
 *   4. cwd basename — legacy fallback, now with a loud stderr warning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const PROJECT_FILE = "project.json";

export interface ResolvedProject {
  project: string;
  source: "flag" | "env" | "file" | "basename";
  /** Path of the marker file when source === "file". */
  file?: string;
}

/** Find `.aitl/project.json` in `startDir` or any ancestor; null when absent/invalid. */
export function findProjectFile(startDir: string): { path: string; project: string } | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".aitl", PROJECT_FILE);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { project?: unknown };
        if (typeof parsed.project === "string" && parsed.project.trim()) {
          return { path: candidate, project: parsed.project.trim() };
        }
      } catch {
        // unreadable/corrupt marker: keep walking up rather than failing the command
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the project key for a command. Warns (stderr) only on the basename fallback. */
export function resolveProject(
  explicit?: string,
  opts: { cwd?: string; env?: Record<string, string | undefined>; warn?: (msg: string) => void } = {},
): ResolvedProject {
  if (explicit?.trim()) return { project: explicit.trim(), source: "flag" };
  const env = opts.env ?? process.env;
  const fromEnv = env.AITL_PROJECT?.trim();
  if (fromEnv) return { project: fromEnv, source: "env" };
  const cwd = opts.cwd ?? process.cwd();
  const marker = findProjectFile(cwd);
  if (marker) return { project: marker.project, source: "file", file: marker.path };
  const fallback = basename(cwd);
  const warn = opts.warn ?? ((msg: string) => console.error(msg));
  warn(
    `[aitl] project no canónico: usando el basename '${fallback}' como fallback — si esa no ` +
      "es la clave real del proyecto verás un scope VACÍO en Mongo. Fija la clave con " +
      "`aitl init` (escribe .aitl/project.json) o exporta AITL_PROJECT.",
  );
  return { project: fallback, source: "basename" };
}

/** Persist the canonical key as `.aitl/project.json` under `rootDir` (used by `aitl init`). */
export function writeProjectFile(rootDir: string, project: string): string {
  const dir = join(resolve(rootDir), ".aitl");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PROJECT_FILE);
  writeFileSync(path, `${JSON.stringify({ project }, null, 2)}\n`, "utf8");
  return path;
}
