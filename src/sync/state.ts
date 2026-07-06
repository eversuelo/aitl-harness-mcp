/**
 * Sync manifest (P4) — `.aitl/.sync-state.json`, the baseline both sides of the
 * bidirectional markdown sync are diffed against.
 *
 * Each entry stores TWO hashes taken at the last successful sync:
 *   - `diskHash`  — sha256 of the file bytes on disk
 *   - `mongoHash` — sha256 of the deterministic markdown RENDER of the Mongo doc
 *
 * Two hashes (instead of one shared content hash) are what make the handwritten
 * `docs/adr/*.md` mirror safe: a file whose prose differs from the canonical render
 * only by formatting stays untouched forever — "changed" means *changed since the
 * baseline on that side*, never "differs from the other side".
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const SYNC_STATE_FILE = ".sync-state.json";

export type SyncEntity = "memory" | "skill" | "agent" | "adr";

export interface SyncEntry {
  entity: SyncEntity;
  /** Natural key: memory slug, definition name, or ADR id. */
  key: string;
  /** Mirror file path as used by the sync run that recorded it. */
  path: string;
  /** sha256 of the file bytes at the last sync. */
  diskHash: string;
  /** sha256 of the canonical render of the Mongo doc at the last sync. */
  mongoHash: string;
  mongoVersion?: number | null;
  /** ISO timestamp of the Mongo doc's updated_at at the last sync. */
  updatedAt?: string | null;
  /** ISO timestamp of the sync that recorded this entry. */
  syncedAt: string;
}

export interface SyncState {
  version: 1;
  entries: SyncEntry[];
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Composite map key for an entry. */
export const entryId = (entity: SyncEntity, key: string): string => `${entity}:${key}`;

export const emptySyncState = (): SyncState => ({ version: 1, entries: [] });

export function stateFilePath(dir: string): string {
  return join(dir, SYNC_STATE_FILE);
}

/** Load the manifest from `<dir>/.sync-state.json` (missing/corrupt → empty state). */
export async function loadSyncState(dir: string): Promise<SyncState> {
  try {
    const raw = await fs.readFile(stateFilePath(dir), "utf-8");
    const parsed = JSON.parse(raw) as SyncState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // fall through
  }
  return emptySyncState();
}

/** Save the manifest deterministically (entries sorted by entity, then key). */
export async function saveSyncState(dir: string, state: SyncState): Promise<string> {
  const sorted: SyncState = {
    version: 1,
    entries: [...state.entries].sort((a, b) =>
      a.entity === b.entity ? a.key.localeCompare(b.key) : a.entity.localeCompare(b.entity),
    ),
  };
  await fs.mkdir(dir, { recursive: true });
  const path = stateFilePath(dir);
  await fs.writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
  return path;
}

/** Index a state's entries by `entity:key` for the sync engine. */
export function stateMap(state: SyncState): Map<string, SyncEntry> {
  return new Map(state.entries.map((e) => [entryId(e.entity, e.key), e]));
}

/**
 * Per-side change detection against the baseline. `null` hash = the doc/file is
 * absent on that side (treated as "changed" so the engine can react to deletions).
 */
export function diffEntry(
  entry: SyncEntry | undefined,
  diskHash: string | null,
  mongoHash: string | null,
): { diskChanged: boolean; mongoChanged: boolean } {
  if (!entry) return { diskChanged: true, mongoChanged: true };
  return {
    diskChanged: diskHash === null || diskHash !== entry.diskHash,
    mongoChanged: mongoHash === null || mongoHash !== entry.mongoHash,
  };
}
