/**
 * Append-only versioning for ADRs and memory docs (ADR-0027).
 *
 * The live collections (`decisions`, `memory`) keep being overwritten in place,
 * keyed by their natural id (project+id / project+slug). Before each overwrite,
 * if the content actually changed, the PREVIOUS doc is snapshotted into a sibling
 * `*_history` collection and the live doc's `version` counter is bumped. Reads of
 * the live collections are untouched; history is queried separately.
 */

import type { Db } from "mongodb";
import { makeHistoryEntry } from "./schemas.js";

export interface VersioningActor {
  id?: string;
  role?: string;
}

/** Fields that define an ADR's content for change detection. */
export const ADR_CONTENT_FIELDS = ["title", "context", "decision", "consequences", "status"] as const;
/** Fields that define a memory doc's content for change detection. */
export const MEMORY_CONTENT_FIELDS = ["description", "body", "type", "tags", "links", "category"] as const;

/** True when any of `fields` differs between prev and next (deep-equal via JSON). */
export function contentChanged(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  for (const f of fields) {
    if (JSON.stringify(prev?.[f] ?? null) !== JSON.stringify(next?.[f] ?? null)) return true;
  }
  return false;
}

/** Remove volatile/heavy fields that should not live in a history snapshot. */
function stripForSnapshot(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, embedding, ...rest } = doc;
  return rest;
}

export interface ArchiveOpts {
  db: Db;
  kind: "decision" | "memory";
  liveCollection: string;
  historyCollection: string;
  query: Record<string, unknown>;
  /** The next doc to be written; its `version` is set here (mutated in place). */
  nextDoc: Record<string, unknown> & { version?: number };
  contentFields: readonly string[];
  ref: string;
  actor?: VersioningActor;
  /** Git branch this write happens on; stamped on the live doc for provenance. */
  branch?: string | null;
}

export interface ArchiveResult {
  changed: boolean;
  version: number;
  archivedVersion?: number;
}

/**
 * Snapshot the prior version (if content changed) and set `nextDoc.version`.
 * Call this BEFORE upserting `nextDoc` into the live collection.
 *
 * - no existing doc        → version = 1, no snapshot
 * - existing, unchanged    → version preserved, no snapshot (idempotent re-sync)
 * - existing, changed      → archive prior @ its version, version = prior + 1
 */
export async function archiveAndBumpVersion(opts: ArchiveOpts): Promise<ArchiveResult> {
  const { db, kind, liveCollection, historyCollection, query, nextDoc, contentFields, ref, actor, branch } = opts;
  // Stamp authorship + branch of the version about to be written (provenance).
  nextDoc.actor_id = actor?.id ?? null;
  nextDoc.actor_role = actor?.role ?? null;
  nextDoc.branch = branch ?? null;

  const existing = (await db.collection(liveCollection).findOne(query)) as Record<string, unknown> | null;

  if (!existing) {
    nextDoc.version = 1;
    return { changed: true, version: 1 };
  }

  const priorVersion = typeof existing.version === "number" ? existing.version : 1;

  if (!contentChanged(existing, nextDoc, contentFields)) {
    // Idempotent re-write: preserve the version and its original authorship/branch.
    nextDoc.version = priorVersion;
    nextDoc.actor_id = (existing.actor_id as string | null) ?? nextDoc.actor_id;
    nextDoc.actor_role = (existing.actor_role as string | null) ?? nextDoc.actor_role;
    nextDoc.branch = (existing.branch as string | null) ?? nextDoc.branch;
    return { changed: false, version: priorVersion };
  }

  // Attribute the archived snapshot to ITS author/branch (the prior version's),
  // not to whoever is superseding it now.
  await db.collection(historyCollection).insertOne(
    makeHistoryEntry({
      project: String(existing.project ?? nextDoc.project ?? ""),
      kind,
      ref,
      version: priorVersion,
      actor_id: (existing.actor_id as string | null) ?? "system",
      actor_role: (existing.actor_role as string | null) ?? "system",
      branch: (existing.branch as string | null) ?? null,
      snapshot: stripForSnapshot(existing),
    }),
  );

  nextDoc.version = priorVersion + 1;
  return { changed: true, version: nextDoc.version, archivedVersion: priorVersion };
}
