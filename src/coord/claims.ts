/**
 * Task claims (ADR-0002 v1) — atomic "I'm working on this" locks with TTL.
 *
 * A claim is the minimal coordination primitive: ONE active claim per
 * (project, task_key), enforced by the partial unique index on `released:false`
 * (src/db/indexes.ts). Claims ALWAYS expire (`expires_at`); the holder extends them
 * via heartbeat/re-claim, and anyone may take over an expired claim (that takeover
 * emits an `expire_reclaim` event so the previous owner finds out on its next poll).
 *
 * Atomicity story (no transactions needed):
 *   1. renew-own       — findOneAndUpdate on {owner_id: me, released:false}.
 *   2. conflict check  — read the active claim; live + foreign → conflict {heldBy}.
 *   3. expired takeover — findOneAndUpdate {released:false, expires_at ≤ now} → released:true
 *                        frees the unique slot (only ONE racer's update matches).
 *   4. insert          — the partial unique index is the lock: a racing insert loses
 *                        with E11000 and is mapped to the same conflict shape.
 *
 * Event emission is best-effort by contract (never breaks the claim/release itself).
 * Every function takes injectable stores (default: real Mongoose models) so tests run
 * without Mongo — same style as `auth/sessions.ts` / `decisions/lifecycle.ts`.
 */

import { hostname, userInfo } from "node:os";
import { type TaskClaim, TaskClaimModel, makeTaskClaim } from "../models/taskClaim.model.js";
import { type CoordEventStore, emitCoordEvent } from "./events.js";
import { ensureCoordStorage } from "./storage.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min

/** Claim lifetime: `AITL_CLAIM_TTL_MS` override, else 30 minutes. */
export function claimTtlMs(): number {
  const n = Number(process.env.AITL_CLAIM_TTL_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Coordination identity of THIS process (the CLI's claim owner). Env override first
 * (`AITL_COORD_OWNER`, then `AITL_MCP_ACTOR_ID`) so two developers — or an E2E test —
 * can present distinct owners; falls back to `cli:<os-user>@<host>`, which already
 * distinguishes collaborators on different machines.
 */
export function coordOwnerId(): string {
  const env = (process.env.AITL_COORD_OWNER ?? process.env.AITL_MCP_ACTOR_ID ?? "").trim();
  if (env) return env;
  try {
    return `cli:${userInfo().username}@${hostname()}`;
  } catch {
    return `cli:${hostname()}`;
  }
}

/** True for a MongoDB duplicate-key error (the partial unique index rejecting a racer). */
export function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === 11000) return true;
  return typeof e.message === "string" && e.message.includes("E11000");
}

// ── injectable persistence seam ───────────────────────────────────────────────

/** Minimal persistence surface the claim functions need — injectable for tests. */
export interface ClaimStore {
  /** The active (released:false) claim of (project, taskKey), if any. */
  findActive(project: string, taskKey: string): Promise<TaskClaim | null>;
  /** Insert a new claim. MUST throw a duplicate-key error while an active claim exists. */
  insert(doc: TaskClaim): Promise<void>;
  /** Atomically renew the caller's OWN active claim (heartbeat + expiry [+ scope]). Null if none. */
  renewOwn(
    project: string,
    taskKey: string,
    ownerId: string,
    heartbeatAt: Date,
    expiresAt: Date,
    scope?: string,
  ): Promise<TaskClaim | null>;
  /** Atomically release the active claim IF it is expired (frees the unique slot). Returns it, else null. */
  releaseExpired(project: string, taskKey: string, now: Date): Promise<TaskClaim | null>;
  /** Atomically release the active claim (ownerId null = any owner, for root force). Returns it, else null. */
  releaseOwn(project: string, taskKey: string, ownerId: string | null, releasedAt: Date): Promise<TaskClaim | null>;
  /** Every claim of the project (active + released), newest first. */
  list(project: string): Promise<TaskClaim[]>;
}

const mongoClaimStore: ClaimStore = {
  async findActive(project, taskKey) {
    await ensureCoordStorage();
    return (await TaskClaimModel.findOne({ project, task_key: taskKey, released: false }).lean()) as TaskClaim | null;
  },
  async insert(doc) {
    await ensureCoordStorage();
    await TaskClaimModel.create(doc);
  },
  async renewOwn(project, taskKey, ownerId, heartbeatAt, expiresAt, scope) {
    await ensureCoordStorage();
    const set: Record<string, unknown> = { heartbeat_at: heartbeatAt, expires_at: expiresAt };
    if (scope !== undefined && scope !== "") set.scope = scope;
    return (await TaskClaimModel.findOneAndUpdate(
      { project, task_key: taskKey, owner_id: ownerId, released: false },
      { $set: set },
      { new: true },
    ).lean()) as TaskClaim | null;
  },
  async releaseExpired(project, taskKey, now) {
    await ensureCoordStorage();
    return (await TaskClaimModel.findOneAndUpdate(
      { project, task_key: taskKey, released: false, expires_at: { $lte: now } },
      { $set: { released: true, released_at: now } },
      { new: true },
    ).lean()) as TaskClaim | null;
  },
  async releaseOwn(project, taskKey, ownerId, releasedAt) {
    await ensureCoordStorage();
    const filter: Record<string, unknown> = { project, task_key: taskKey, released: false };
    if (ownerId !== null) filter.owner_id = ownerId;
    return (await TaskClaimModel.findOneAndUpdate(
      filter,
      { $set: { released: true, released_at: releasedAt } },
      { new: true },
    ).lean()) as TaskClaim | null;
  },
  async list(project) {
    await ensureCoordStorage();
    return (await TaskClaimModel.find({ project }).sort({ claimed_at: -1 }).lean()) as unknown as TaskClaim[];
  },
};

/** Injectable dependencies (stores + clock). Tests override; production uses the defaults. */
export interface CoordDeps {
  claims?: ClaimStore;
  events?: CoordEventStore;
  now?: () => Date;
}

/** Best-effort event emission: a coord_event failure NEVER breaks the primary operation. */
async function emitBestEffort(
  events: CoordEventStore | undefined,
  opts: Parameters<typeof emitCoordEvent>[0],
): Promise<void> {
  try {
    if (events) await emitCoordEvent(opts, events);
    else await emitCoordEvent(opts);
  } catch {
    // best-effort by contract
  }
}

// ── claim ─────────────────────────────────────────────────────────────────────

export interface ClaimOpts {
  project: string;
  taskKey: string;
  scope?: string;
  ownerId: string;
  ttlMs?: number;
}

export type ClaimResult =
  | {
      ok: true;
      /** true → the caller already held it; heartbeat/expiry extended, no event emitted. */
      renewed: boolean;
      /** true → taken over from an EXPIRED claim (emitted `expire_reclaim`). */
      reclaimed: boolean;
      claim: TaskClaim;
    }
  | { ok: false; conflict: true; heldBy: string; expiresAt: Date };

/**
 * Claim (project, taskKey) atomically. Outcomes: renew own → extend; live foreign
 * claim → conflict {heldBy, expiresAt}; expired claim → take over (+`expire_reclaim`
 * event); free slot → insert (+`claim` event). Racing inserts lose via E11000 and
 * get the conflict shape.
 */
export async function claimTask(opts: ClaimOpts, deps: CoordDeps = {}): Promise<ClaimResult> {
  const claims = deps.claims ?? mongoClaimStore;
  const now = deps.now?.() ?? new Date();
  const ttl = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : claimTtlMs();
  const expiresAt = new Date(now.getTime() + ttl);

  // 1) Same owner re-claiming → renewal (idempotent; no event noise).
  const renewed = await claims.renewOwn(opts.project, opts.taskKey, opts.ownerId, now, expiresAt, opts.scope);
  if (renewed) return { ok: true, renewed: true, reclaimed: false, claim: renewed };

  // 2) Someone else holds it?
  const active = await claims.findActive(opts.project, opts.taskKey);
  if (active && new Date(active.expires_at).getTime() > now.getTime()) {
    return { ok: false, conflict: true, heldBy: active.owner_id, expiresAt: new Date(active.expires_at) };
  }

  // 3) Expired-but-unreleased → free the unique slot atomically (one racer wins the update;
  //    losers fall through and lose the insert below with E11000).
  let reclaimedFrom: string | null = null;
  if (active) {
    const released = await claims.releaseExpired(opts.project, opts.taskKey, now);
    if (released) reclaimedFrom = released.owner_id;
  }

  // 4) Insert — the partial unique index is the lock.
  const doc = await makeTaskClaim({
    project: opts.project,
    task_key: opts.taskKey,
    scope: opts.scope ?? "",
    owner_id: opts.ownerId,
    claimed_at: now,
    heartbeat_at: now,
    expires_at: expiresAt,
  });
  try {
    await claims.insert(doc);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const winner = await claims.findActive(opts.project, opts.taskKey);
    return {
      ok: false,
      conflict: true,
      heldBy: winner?.owner_id ?? "unknown",
      expiresAt: winner ? new Date(winner.expires_at) : expiresAt,
    };
  }

  await emitBestEffort(deps.events, {
    project: opts.project,
    type: reclaimedFrom !== null ? "expire_reclaim" : "claim",
    taskKey: opts.taskKey,
    actorId: opts.ownerId,
    payload: {
      scope: opts.scope ?? "",
      expires_at: expiresAt.toISOString(),
      ...(reclaimedFrom !== null ? { reclaimed_from: reclaimedFrom } : {}),
    },
  });
  return { ok: true, renewed: false, reclaimed: reclaimedFrom !== null, claim: doc };
}

// ── heartbeat ─────────────────────────────────────────────────────────────────

export type HeartbeatResult =
  | { ok: true; expiresAt: Date; heartbeatAt: Date }
  | { ok: false; reason: "no_active_claim" }
  | { ok: false; reason: "not_owner"; heldBy: string };

/** Renew `heartbeat_at` and extend `expires_at` of the caller's OWN active claim. */
export async function heartbeat(
  opts: { project: string; taskKey: string; ownerId: string; ttlMs?: number },
  deps: CoordDeps = {},
): Promise<HeartbeatResult> {
  const claims = deps.claims ?? mongoClaimStore;
  const now = deps.now?.() ?? new Date();
  const ttl = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : claimTtlMs();
  const expiresAt = new Date(now.getTime() + ttl);
  const doc = await claims.renewOwn(opts.project, opts.taskKey, opts.ownerId, now, expiresAt);
  if (doc) return { ok: true, expiresAt, heartbeatAt: now };
  const active = await claims.findActive(opts.project, opts.taskKey);
  if (!active) return { ok: false, reason: "no_active_claim" };
  return { ok: false, reason: "not_owner", heldBy: active.owner_id };
}

// ── release ───────────────────────────────────────────────────────────────────

export const RELEASE_OUTCOMES = ["done", "abandoned"] as const;
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

export type ReleaseResult =
  | { ok: true; taskKey: string; outcome: ReleaseOutcome; releasedAt: Date; owner: string }
  | { ok: false; reason: "no_active_claim" }
  | { ok: false; reason: "not_owner"; heldBy: string }
  | { ok: false; reason: "force_requires_root" };

/**
 * Release the caller's OWN active claim (emits a `release` event with the outcome).
 * `force:true` releases ANY owner's claim but requires `role:"root"`.
 */
export async function releaseTask(
  opts: {
    project: string;
    taskKey: string;
    ownerId: string;
    outcome?: ReleaseOutcome;
    force?: boolean;
    role?: string;
  },
  deps: CoordDeps = {},
): Promise<ReleaseResult> {
  const claims = deps.claims ?? mongoClaimStore;
  const now = deps.now?.() ?? new Date();
  const outcome: ReleaseOutcome = opts.outcome ?? "done";
  if (opts.force && opts.role !== "root") return { ok: false, reason: "force_requires_root" };

  const doc = await claims.releaseOwn(opts.project, opts.taskKey, opts.force ? null : opts.ownerId, now);
  if (!doc) {
    const active = await claims.findActive(opts.project, opts.taskKey);
    if (!active) return { ok: false, reason: "no_active_claim" };
    return { ok: false, reason: "not_owner", heldBy: active.owner_id };
  }

  await emitBestEffort(deps.events, {
    project: opts.project,
    type: "release",
    taskKey: opts.taskKey,
    actorId: opts.ownerId,
    payload: { outcome, owner: doc.owner_id, ...(opts.force ? { forced: true } : {}) },
  });
  return { ok: true, taskKey: opts.taskKey, outcome, releasedAt: now, owner: doc.owner_id };
}

// ── list ──────────────────────────────────────────────────────────────────────

/**
 * Claims of a project, newest first. `active:true` (default) keeps only live ones
 * (released:false AND not expired); `active:false` returns the full history.
 */
export async function listClaims(
  project: string,
  opts: { active?: boolean } = {},
  deps: CoordDeps = {},
): Promise<TaskClaim[]> {
  const claims = deps.claims ?? mongoClaimStore;
  const now = deps.now?.() ?? new Date();
  const all = await claims.list(project);
  if (opts.active === false) return all;
  return all.filter((c) => !c.released && new Date(c.expires_at).getTime() > now.getTime());
}
