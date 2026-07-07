import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoordEvent } from "../models/coordEvent.model.js";
import type { TaskClaim } from "../models/taskClaim.model.js";
import {
  type ClaimStore,
  claimTask,
  claimTtlMs,
  heartbeat,
  isDuplicateKeyError,
  listClaims,
  releaseTask,
} from "./claims.js";
import type { CoordEventStore } from "./events.js";

/**
 * In-memory ClaimStore mirroring the Mongo semantics, including the partial unique
 * index: inserting while an active (released:false) claim exists throws E11000.
 */
function fakeClaimStore(initial: TaskClaim[] = []): ClaimStore & { docs: TaskClaim[] } {
  const docs = initial.map((d) => ({ ...d }));
  const activeOf = (project: string, taskKey: string) =>
    docs.find((d) => d.project === project && d.task_key === taskKey && !d.released) ?? null;
  return {
    docs,
    async findActive(project, taskKey) {
      const d = activeOf(project, taskKey);
      return d ? { ...d } : null;
    },
    async insert(doc) {
      if (activeOf(doc.project, doc.task_key)) {
        throw Object.assign(new Error("E11000 duplicate key error collection: aitl.task_claims"), { code: 11000 });
      }
      docs.push({ ...doc });
    },
    async renewOwn(project, taskKey, ownerId, heartbeatAt, expiresAt, scope) {
      const d = activeOf(project, taskKey);
      if (!d || d.owner_id !== ownerId) return null;
      d.heartbeat_at = heartbeatAt;
      d.expires_at = expiresAt;
      if (scope !== undefined && scope !== "") d.scope = scope;
      return { ...d };
    },
    async releaseExpired(project, taskKey, now) {
      const d = activeOf(project, taskKey);
      if (!d || new Date(d.expires_at).getTime() > now.getTime()) return null;
      d.released = true;
      d.released_at = now;
      return { ...d };
    },
    async releaseOwn(project, taskKey, ownerId, releasedAt) {
      const d = activeOf(project, taskKey);
      if (!d || (ownerId !== null && d.owner_id !== ownerId)) return null;
      d.released = true;
      d.released_at = releasedAt;
      return { ...d };
    },
    async list(project) {
      return docs.filter((d) => d.project === project).map((d) => ({ ...d }));
    },
  };
}

/** In-memory CoordEventStore capturing emissions. */
function fakeEventStore(): CoordEventStore & { docs: CoordEvent[] } {
  const docs: CoordEvent[] = [];
  return {
    docs,
    async insert(doc) {
      docs.push({ ...doc });
    },
    async listSince(project, since, limit) {
      return docs
        .filter((d) => d.project === project && (!since || new Date(d.created_at).getTime() > since.getTime()))
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .slice(0, limit);
    },
  };
}

const P = "proj";
const T = "T3-tenant-isolation";

test("claimTask: two claimants contend — one wins, the other gets heldBy + expiresAt", async () => {
  const claims = fakeClaimStore();
  const events = fakeEventStore();

  const a = await claimTask({ project: P, taskKey: T, scope: "backend", ownerId: "alice" }, { claims, events });
  assert.equal(a.ok, true);
  assert.ok(a.ok && !a.renewed && !a.reclaimed);

  const b = await claimTask({ project: P, taskKey: T, ownerId: "bob" }, { claims, events });
  assert.equal(b.ok, false);
  assert.ok(!b.ok && b.conflict);
  assert.equal(!b.ok && b.heldBy, "alice");
  assert.ok(!b.ok && b.expiresAt instanceof Date);

  // Exactly one claim event, from the winner; the loser emitted nothing.
  assert.deepEqual(events.docs.map((e) => e.type), ["claim"]);
  assert.equal(events.docs[0].actor_id, "alice");
  assert.equal(events.docs[0].task_key, T);
  assert.equal((events.docs[0].payload as Record<string, unknown>).scope, "backend");
});

test("claimTask: insert race (findActive saw nothing, unique index says otherwise) → conflict via E11000", async () => {
  const events = fakeEventStore();
  const winner: TaskClaim = {
    project: P,
    task_key: T,
    scope: "",
    owner_id: "alice",
    claimed_at: new Date(),
    heartbeat_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    released: false,
    released_at: null,
  };
  // Simulate the race window: renewOwn/findActive see NO active claim, but the
  // insert hits the partial unique index; the post-conflict re-read finds the winner.
  let findCalls = 0;
  const racing: ClaimStore = {
    async findActive() {
      findCalls += 1;
      return findCalls === 1 ? null : { ...winner };
    },
    async insert() {
      throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    },
    async renewOwn() {
      return null;
    },
    async releaseExpired() {
      return null;
    },
    async releaseOwn() {
      return null;
    },
    async list() {
      return [];
    },
  };

  const res = await claimTask({ project: P, taskKey: T, ownerId: "bob" }, { claims: racing, events });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.heldBy, "alice");
  assert.equal(events.docs.length, 0); // the loser never emits
});

test("claimTask: an EXPIRED claim is taken over and emits expire_reclaim with the previous owner", async () => {
  const now = new Date("2026-07-06T12:00:00Z");
  const claims = fakeClaimStore([
    {
      project: P,
      task_key: T,
      scope: "old",
      owner_id: "alice",
      claimed_at: new Date("2026-07-06T11:00:00Z"),
      heartbeat_at: new Date("2026-07-06T11:00:00Z"),
      expires_at: new Date("2026-07-06T11:30:00Z"), // expired
      released: false,
      released_at: null,
    },
  ]);
  const events = fakeEventStore();

  const res = await claimTask({ project: P, taskKey: T, ownerId: "bob", ttlMs: 60_000 }, { claims, events, now: () => now });
  assert.equal(res.ok, true);
  assert.ok(res.ok && res.reclaimed && !res.renewed);
  assert.equal(res.ok && res.claim.owner_id, "bob");
  assert.deepEqual(res.ok ? res.claim.expires_at : null, new Date(now.getTime() + 60_000));

  // The stale claim was released; a fresh active one exists for bob.
  const alice = claims.docs.find((d) => d.owner_id === "alice");
  assert.equal(alice?.released, true);
  assert.deepEqual(alice?.released_at, now);

  assert.deepEqual(events.docs.map((e) => e.type), ["expire_reclaim"]);
  const payload = events.docs[0].payload as Record<string, unknown>;
  assert.equal(payload.reclaimed_from, "alice");
  assert.equal(events.docs[0].actor_id, "bob");
});

test("claimTask: a LIVE foreign claim is NOT reclaimable (conflict, nothing released)", async () => {
  const now = new Date("2026-07-06T12:00:00Z");
  const claims = fakeClaimStore([
    {
      project: P,
      task_key: T,
      scope: "",
      owner_id: "alice",
      claimed_at: now,
      heartbeat_at: now,
      expires_at: new Date(now.getTime() + 10 * 60_000), // still live
      released: false,
      released_at: null,
    },
  ]);
  const events = fakeEventStore();
  const res = await claimTask({ project: P, taskKey: T, ownerId: "bob" }, { claims, events, now: () => now });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.heldBy, "alice");
  assert.equal(claims.docs[0].released, false);
  assert.equal(events.docs.length, 0);
});

test("claimTask: re-claim by the SAME owner renews (extends expiry, updates scope, no event)", async () => {
  const t0 = new Date("2026-07-06T12:00:00Z");
  const t1 = new Date("2026-07-06T12:10:00Z");
  const claims = fakeClaimStore();
  const events = fakeEventStore();

  await claimTask({ project: P, taskKey: T, ownerId: "alice", ttlMs: 30 * 60_000 }, { claims, events, now: () => t0 });
  const renewed = await claimTask(
    { project: P, taskKey: T, scope: "backend v2", ownerId: "alice", ttlMs: 30 * 60_000 },
    { claims, events, now: () => t1 },
  );
  assert.ok(renewed.ok && renewed.renewed);
  assert.deepEqual(renewed.ok ? renewed.claim.expires_at : null, new Date(t1.getTime() + 30 * 60_000));
  assert.equal(renewed.ok ? renewed.claim.scope : "", "backend v2");
  assert.equal(claims.docs.length, 1); // no second doc
  assert.deepEqual(events.docs.map((e) => e.type), ["claim"]); // renewal adds no event noise
});

test("heartbeat: the owner extends expires_at/heartbeat_at; strangers and missing claims are rejected", async () => {
  const t0 = new Date("2026-07-06T12:00:00Z");
  const t1 = new Date("2026-07-06T12:05:00Z");
  const claims = fakeClaimStore();
  await claimTask({ project: P, taskKey: T, ownerId: "alice", ttlMs: 10 * 60_000 }, { claims, now: () => t0 });

  const hb = await heartbeat({ project: P, taskKey: T, ownerId: "alice", ttlMs: 10 * 60_000 }, { claims, now: () => t1 });
  assert.ok(hb.ok);
  assert.deepEqual(hb.ok ? hb.expiresAt : null, new Date(t1.getTime() + 10 * 60_000));
  assert.deepEqual(claims.docs[0].heartbeat_at, t1);

  const stranger = await heartbeat({ project: P, taskKey: T, ownerId: "bob" }, { claims, now: () => t1 });
  assert.ok(!stranger.ok && stranger.reason === "not_owner" && stranger.heldBy === "alice");

  const missing = await heartbeat({ project: P, taskKey: "other-task", ownerId: "alice" }, { claims, now: () => t1 });
  assert.ok(!missing.ok && missing.reason === "no_active_claim");
});

test("releaseTask: non-owner is rejected with heldBy; owner releases and emits the outcome", async () => {
  const claims = fakeClaimStore();
  const events = fakeEventStore();
  await claimTask({ project: P, taskKey: T, ownerId: "alice" }, { claims, events });

  const denied = await releaseTask({ project: P, taskKey: T, ownerId: "bob" }, { claims, events });
  assert.ok(!denied.ok && denied.reason === "not_owner" && denied.heldBy === "alice");
  assert.equal(claims.docs[0].released, false);

  const ok = await releaseTask({ project: P, taskKey: T, ownerId: "alice", outcome: "abandoned" }, { claims, events });
  assert.ok(ok.ok && ok.outcome === "abandoned");
  assert.equal(claims.docs[0].released, true);
  assert.deepEqual(events.docs.map((e) => e.type), ["claim", "release"]);
  assert.equal((events.docs[1].payload as Record<string, unknown>).outcome, "abandoned");

  const again = await releaseTask({ project: P, taskKey: T, ownerId: "alice" }, { claims, events });
  assert.ok(!again.ok && again.reason === "no_active_claim");
});

test("releaseTask: force requires root; root force releases a foreign claim", async () => {
  const claims = fakeClaimStore();
  const events = fakeEventStore();
  await claimTask({ project: P, taskKey: T, ownerId: "alice" }, { claims, events });

  const notRoot = await releaseTask({ project: P, taskKey: T, ownerId: "bob", force: true, role: "agent" }, { claims, events });
  assert.ok(!notRoot.ok && notRoot.reason === "force_requires_root");

  const forced = await releaseTask({ project: P, taskKey: T, ownerId: "root:cli", force: true, role: "root" }, { claims, events });
  assert.ok(forced.ok && forced.owner === "alice");
  assert.equal(claims.docs[0].released, true);
  assert.equal((events.docs.at(-1)?.payload as Record<string, unknown>).forced, true);
});

test("claim → release → re-claim by another owner succeeds (released history stays)", async () => {
  const claims = fakeClaimStore();
  const events = fakeEventStore();

  const a = await claimTask({ project: P, taskKey: T, ownerId: "alice" }, { claims, events });
  assert.ok(a.ok);
  const rel = await releaseTask({ project: P, taskKey: T, ownerId: "alice", outcome: "done" }, { claims, events });
  assert.ok(rel.ok);
  const b = await claimTask({ project: P, taskKey: T, ownerId: "bob" }, { claims, events });
  assert.ok(b.ok && !b.renewed && !b.reclaimed);

  assert.equal(claims.docs.length, 2); // released history + new active claim
  assert.deepEqual(events.docs.map((e) => e.type), ["claim", "release", "claim"]);
});

test("claimTask: a failing event store never breaks the claim (best-effort emission)", async () => {
  const claims = fakeClaimStore();
  const failing: CoordEventStore = {
    async insert() {
      throw new Error("coord_events down");
    },
    async listSince() {
      return [];
    },
  };
  const res = await claimTask({ project: P, taskKey: T, ownerId: "alice" }, { claims, events: failing });
  assert.ok(res.ok);
  assert.equal(claims.docs.length, 1);
});

test("listClaims: active-only by default (drops released AND expired); {active:false} returns all", async () => {
  const now = new Date("2026-07-06T12:00:00Z");
  const mk = (task: string, expires: Date, released: boolean): TaskClaim => ({
    project: P,
    task_key: task,
    scope: "",
    owner_id: "alice",
    claimed_at: new Date("2026-07-06T11:00:00Z"),
    heartbeat_at: new Date("2026-07-06T11:00:00Z"),
    expires_at: expires,
    released,
    released_at: released ? now : null,
  });
  const claims = fakeClaimStore([
    mk("live", new Date(now.getTime() + 60_000), false),
    mk("expired", new Date(now.getTime() - 60_000), false),
    mk("done", new Date(now.getTime() + 60_000), true),
  ]);

  const active = await listClaims(P, {}, { claims, now: () => now });
  assert.deepEqual(active.map((c) => c.task_key), ["live"]);
  const all = await listClaims(P, { active: false }, { claims, now: () => now });
  assert.equal(all.length, 3);
});

test("claimTtlMs: AITL_CLAIM_TTL_MS overrides the 30-min default; junk falls back", () => {
  const prev = process.env.AITL_CLAIM_TTL_MS;
  try {
    delete process.env.AITL_CLAIM_TTL_MS;
    assert.equal(claimTtlMs(), 30 * 60 * 1000);
    process.env.AITL_CLAIM_TTL_MS = "60000";
    assert.equal(claimTtlMs(), 60_000);
    process.env.AITL_CLAIM_TTL_MS = "not-a-number";
    assert.equal(claimTtlMs(), 30 * 60 * 1000);
    process.env.AITL_CLAIM_TTL_MS = "-5";
    assert.equal(claimTtlMs(), 30 * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.AITL_CLAIM_TTL_MS;
    else process.env.AITL_CLAIM_TTL_MS = prev;
  }
});

test("isDuplicateKeyError recognizes code 11000 and E11000 messages only", () => {
  assert.equal(isDuplicateKeyError(Object.assign(new Error("dup"), { code: 11000 })), true);
  assert.equal(isDuplicateKeyError(new Error("E11000 duplicate key error")), true);
  assert.equal(isDuplicateKeyError(new Error("some other failure")), false);
  assert.equal(isDuplicateKeyError(null), false);
  assert.equal(isDuplicateKeyError("E11000"), false);
});
