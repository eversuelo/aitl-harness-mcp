/**
 * Read helpers for the append-only revision history (ADR-0027).
 *
 * Reconstructs the full version chain of an ADR or memory doc: the archived
 * snapshots from `*_history` (oldest first) followed by the current live doc as
 * the newest version. Used by the CLI `history` commands (and reusable by the API).
 */

import type { Db } from "mongodb";
import { getDb } from "../db/client.js";

export type HistoryKind = "decision" | "memory";

export interface VersionEntry {
  version: number;
  doc: Record<string, unknown>;
  /** true for the current (live) version, false for an archived snapshot. */
  live: boolean;
  archived_at?: Date;
  actor_id?: string;
  actor_role?: string;
  branch?: string | null;
}

const CONFIG = {
  decision: { live: "decisions", history: "decisions_history", key: "id" },
  memory: { live: "memory", history: "memory_history", key: "slug" },
} as const;

/** Load the full version chain (oldest → newest, newest = live), or [] if not found. */
export async function loadVersionChain(
  kind: HistoryKind,
  project: string,
  ref: string,
  db: Db = getDb(),
): Promise<VersionEntry[]> {
  const cfg = CONFIG[kind];
  const live = await db.collection(cfg.live).findOne({ project, [cfg.key]: ref }, { projection: { embedding: 0 } });
  const history = await db
    .collection(cfg.history)
    .find({ project, ref }, { projection: { "snapshot.embedding": 0 } })
    .sort({ version: 1 })
    .toArray();

  const entries: VersionEntry[] = history.map((h) => ({
    version: Number(h.version),
    doc: (h.snapshot as Record<string, unknown>) ?? {},
    live: false,
    archived_at: h.archived_at as Date | undefined,
    actor_id: h.actor_id as string | undefined,
    actor_role: h.actor_role as string | undefined,
    branch: (h.branch as string | null | undefined) ?? null,
  }));

  if (live) {
    entries.push({
      version: typeof live.version === "number" ? live.version : 1,
      doc: live as Record<string, unknown>,
      live: true,
      actor_id: (live.actor_id as string | undefined) ?? undefined,
      actor_role: (live.actor_role as string | undefined) ?? undefined,
      branch: (live.branch as string | null | undefined) ?? null,
    });
  }
  return entries;
}
