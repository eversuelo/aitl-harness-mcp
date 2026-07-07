/**
 * Coordination events (ADR-0002 v1) — durable, POLLED notification channel.
 *
 * `emitCoordEvent` appends one event; `pollEvents` reads everything newer than a
 * cursor (`since`) in ascending order and returns the max timestamp seen, so callers
 * chain incremental polls without missing or repeating events. Change streams and
 * HMAC webhooks from the full ADR-0002 design are explicitly deferred; polling is
 * the whole notification story of this slice.
 *
 * `recordCoordNote` is the best-effort door for OTHER subsystems (record_decision,
 * task runners…) to announce themselves: it swallows every failure by contract —
 * a coordination hiccup must never break the primary operation.
 *
 * Every function takes an injectable {@link CoordEventStore} (defaulting to the real
 * `CoordEventModel`) so tests run without Mongo — same style as `auth/sessions.ts`.
 */

import {
  type CoordEvent,
  type CoordEventType,
  CoordEventModel,
  makeCoordEvent,
} from "../models/coordEvent.model.js";
import { ensureCoordStorage } from "./storage.js";

/** Minimal persistence surface the event functions need — injectable for tests. */
export interface CoordEventStore {
  insert(doc: CoordEvent): Promise<void>;
  /** Events of `project` strictly AFTER `since` (null = from the beginning), ascending, capped at `limit`. */
  listSince(project: string, since: Date | null, limit: number): Promise<CoordEvent[]>;
}

const mongoCoordEventStore: CoordEventStore = {
  async insert(doc) {
    await ensureCoordStorage();
    await CoordEventModel.create(doc);
  },
  async listSince(project, since, limit) {
    await ensureCoordStorage();
    const filter: Record<string, unknown> = { project };
    if (since) filter.created_at = { $gt: since };
    return (await CoordEventModel.find(filter).sort({ created_at: 1 }).limit(limit).lean()) as unknown as CoordEvent[];
  },
};

export interface EmitCoordEventOpts {
  project: string;
  type: CoordEventType;
  taskKey?: string | null;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

/** Append one coordination event. Throws on failure — wrap with `recordCoordNote` for best-effort. */
export async function emitCoordEvent(
  opts: EmitCoordEventOpts,
  store: CoordEventStore = mongoCoordEventStore,
): Promise<CoordEvent> {
  const doc = await makeCoordEvent({
    project: opts.project,
    type: opts.type,
    task_key: opts.taskKey ?? null,
    actor_id: opts.actorId ?? null,
    payload: opts.payload ?? {},
  });
  await store.insert(doc);
  return doc;
}

/** Event types other subsystems may announce through {@link recordCoordNote}. */
export type CoordNoteType = Extract<CoordEventType, "decision" | "task_done" | "note">;

/**
 * Best-effort announcement for other subsystems (e.g. record_decision emits a
 * `decision` event so peers polling the same DB see "[decision] nuevo ADR …").
 * NEVER throws: coordination must never block the primary operation.
 */
export async function recordCoordNote(
  project: string,
  type: CoordNoteType,
  payload: Record<string, unknown>,
  opts: { taskKey?: string | null; actorId?: string | null; store?: CoordEventStore } = {},
): Promise<{ ok: boolean }> {
  try {
    await emitCoordEvent(
      { project, type, taskKey: opts.taskKey ?? null, actorId: opts.actorId ?? null, payload },
      opts.store ?? mongoCoordEventStore,
    );
    return { ok: true };
  } catch {
    // Best-effort by contract: swallow storage/validation failures silently.
    return { ok: false };
  }
}

// ── polling ───────────────────────────────────────────────────────────────────

const DEFAULT_POLL_LIMIT = 100;
const MAX_POLL_LIMIT = 500;

export interface PollResult {
  events: CoordEvent[];
  /** Max `created_at` returned (cursor for the NEXT poll); falls back to `since`, else null. */
  cursor: Date | null;
  count: number;
}

/** Normalize a `since` cursor (Date | ISO string). Throws on an unparseable string. */
export function normalizeSince(since: Date | string | undefined | null): Date | null {
  if (since == null) return null;
  const d = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid 'since' timestamp '${String(since)}' (use ISO, e.g. 2026-07-06T12:00:00Z)`);
  return d;
}

/**
 * Incremental poll: events strictly newer than `since`, ascending, plus the cursor
 * for the next call. Polling twice with the returned cursor yields no repeats.
 */
export async function pollEvents(
  project: string,
  opts: { since?: Date | string | null; limit?: number } = {},
  store: CoordEventStore = mongoCoordEventStore,
): Promise<PollResult> {
  const since = normalizeSince(opts.since);
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_POLL_LIMIT)
      : DEFAULT_POLL_LIMIT;
  const events = await store.listSince(project, since, limit);
  const last = events.at(-1);
  const cursor = last ? new Date(last.created_at) : since;
  return { events, cursor, count: events.length };
}

// ── compact rendering (CLI `aitl coord poll`, hooks, TUI) ─────────────────────

const hhmm = (d: Date | string | null | undefined): string => {
  if (d == null) return "?";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "?" : date.toTimeString().slice(0, 5);
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** One compact line per event — the shape hooks/TUIs print verbatim. Pure (testable). */
export function formatCoordEvent(evt: CoordEvent): string {
  const p = (evt.payload ?? {}) as Record<string, unknown>;
  const who = str(evt.actor_id) ?? "alguien";
  const task = str(evt.task_key) ?? "(sin task)";
  switch (evt.type) {
    case "claim": {
      const scope = str(p.scope);
      return `[claim] ${who} tomó ${task}${scope ? ` [${scope}]` : ""} (expira ${hhmm(p.expires_at as Date | string | undefined)})`;
    }
    case "expire_reclaim": {
      const prev = str(p.reclaimed_from);
      return `[expire_reclaim] ${who} reclamó ${task}${prev ? ` (antes ${prev},` : " ("}expira ${hhmm(p.expires_at as Date | string | undefined)})`;
    }
    case "release":
      return `[release] ${who} soltó ${task} (${str(p.outcome) ?? "done"})`;
    case "decision":
      return `[decision] nuevo ADR ${str(p.id) ?? "?"}: ${str(p.title) ?? "(sin título)"}`;
    case "task_done":
      return `[task_done] ${who} terminó ${str(p.task) ?? task}${str(p.summary) ? ` — ${str(p.summary)}` : ""}`;
    case "note":
      return `[note] ${who}: ${str(p.text) ?? JSON.stringify(p)}`;
    default:
      return `[${evt.type}] ${who} ${task}`;
  }
}
