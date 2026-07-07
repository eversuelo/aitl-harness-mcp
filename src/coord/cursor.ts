/**
 * Poll-cursor persistence for `aitl coord poll` (ADR-0002 v1).
 *
 * Each project's last-seen coordination timestamp is stored in
 * `~/.aitl/coord-cursor-<projecthash>.json` (base dir honours `AITL_HOME`, like the
 * config profile), so consecutive `aitl coord poll` invocations — including ones fired
 * from hooks — are incremental without the caller threading `--since` around.
 * The hash keeps arbitrary project strings (slashes, spaces…) filename-safe.
 *
 * Load is forgiving (missing/corrupt file → null → the CLI falls back to "last 60
 * min"); save is atomic-enough for a single-user file (small full rewrite).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config/store.js";

/** Filename-safe project key: first 16 hex chars of sha256(project). */
export function projectHash(project: string): string {
  return createHash("sha256").update(project).digest("hex").slice(0, 16);
}

export function cursorFilePath(project: string, baseDir: string = configDir()): string {
  return join(baseDir, `coord-cursor-${projectHash(project)}.json`);
}

/** Last stored cursor for the project, or null (missing / unreadable / invalid date). */
export function loadCursor(project: string, baseDir?: string): Date | null {
  try {
    const raw = JSON.parse(readFileSync(cursorFilePath(project, baseDir), "utf-8")) as { cursor?: unknown };
    if (typeof raw.cursor !== "string") return null;
    const d = new Date(raw.cursor);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Persist the cursor (creates the base dir if needed). Keeps the plaintext project for debugging. */
export function saveCursor(project: string, cursor: Date, baseDir?: string): void {
  const path = cursorFilePath(project, baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ project, cursor: cursor.toISOString(), updated_at: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
}
