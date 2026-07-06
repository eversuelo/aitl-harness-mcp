import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { hydrate, partitionDecisions } from "../memory/lifecycle.js";
import type { MemoryStore } from "../memory/store.js";
import { ADR_CONTENT_FIELDS, archiveAndBumpVersion } from "../memory/versioning.js";
import { type ADR, DecisionModel, makeADR } from "../models/decision.model.js";
import { DecisionHistoryModel } from "../models/history.model.js";
import {
  type DeprecateDeps,
  deprecateDecision,
  isReviewOverdue,
  proposeDeprecationsFrom,
  titleSimilarity,
} from "./lifecycle.js";

/**
 * In-memory stand-ins, mirroring versioning.test.ts: `archiveAndBumpVersion` reads the
 * live doc via `DecisionModel.findOne(...).lean()` and archives via
 * `DecisionHistoryModel.create(...)` — both stubbed and backed by local arrays so no
 * Mongo is needed.
 */
function stubModels(initialLive: Record<string, unknown>[] = []): {
  live: Record<string, unknown>[];
  history: Record<string, unknown>[];
  restore: () => void;
} {
  const live = [...initialLive];
  const history: Record<string, unknown>[] = [];

  mock.method(DecisionModel, "findOne", ((query: Record<string, unknown>) => ({
    lean() {
      return Promise.resolve(
        live.find((d) => Object.entries(query).every(([k, v]) => d[k] === v)) ?? null,
      );
    },
  })) as never);

  mock.method(DecisionHistoryModel, "create", ((doc: Record<string, unknown>) => {
    history.push(doc);
    return Promise.resolve(doc);
  }) as never);

  return { live, history, restore: () => mock.restoreAll() };
}

/** Deps that run the REAL versioning path over the stubbed models (no ensureMongoose/embedder). */
function depsOver(live: Record<string, unknown>[]): DeprecateDeps {
  return {
    load: async (project, id) => live.find((d) => d.project === project && d.id === id) ?? null,
    upsert: async (adr: ADR, opts) => {
      await archiveAndBumpVersion({
        kind: "decision",
        query: { project: adr.project, id: adr.id },
        nextDoc: adr as unknown as Record<string, unknown> & { version?: number },
        contentFields: ADR_CONTENT_FIELDS,
        ref: adr.id,
        actor: opts.actor,
        branch: opts.branch ?? null,
        commit_sha: opts.commit_sha ?? null,
      });
      const i = live.findIndex((d) => d.project === adr.project && d.id === adr.id);
      if (i >= 0) live[i] = adr as unknown as Record<string, unknown>;
      else live.push(adr as unknown as Record<string, unknown>);
      return adr.id;
    },
  };
}

// ── deprecate round-trip ──────────────────────────────────────────────────────

test("deprecateDecision flips status+reason, bumps the version and archives the prior one", async () => {
  const { live, history, restore } = stubModels([
    {
      project: "p", id: "0001", title: "Use REST", context: "ctx", decision: "REST everywhere",
      consequences: "simple, cacheable", status: "accepted", version: 1, actor_id: "alice", actor_role: "root",
    },
  ]);
  try {
    const res = await deprecateDecision(
      { project: "p", id: "0001", reason: "replaced by GraphQL", supersededBy: "0002", actor: { id: "bob", role: "root" } },
      depsOver(live),
    );
    assert.deepEqual(res, { id: "0001", status: "deprecated", version: 2 });

    // Live doc: deprecated with reason + pointer, re-versioned, content preserved.
    const doc = live.find((d) => d.id === "0001") as Record<string, unknown>;
    assert.equal(doc.status, "deprecated");
    assert.equal(doc.deprecation_reason, "replaced by GraphQL");
    assert.equal(doc.superseded_by, "0002");
    assert.equal(doc.decision, "REST everywhere"); // never deleted, content intact
    assert.equal(doc.version, 2);

    // History: the ACTIVE v1 snapshot survives, attributed to its author.
    assert.equal(history.length, 1);
    assert.equal(history[0].version, 1);
    assert.equal(history[0].actor_id, "alice");
    assert.equal((history[0].snapshot as Record<string, unknown>).status, "accepted");
  } finally {
    restore();
  }
});

test("deprecateDecision throws for an unknown ADR", async () => {
  await assert.rejects(
    deprecateDecision({ project: "p", id: "9999", reason: "x" }, { load: async () => null, upsert: async () => "9999" }),
    /No ADR '9999'/,
  );
});

// ── model enum ────────────────────────────────────────────────────────────────

test("ADR status enum accepts 'deprecated' and rejects values outside the enum", async () => {
  const base = { project: "p", id: "0009", title: "t", context: "c", decision: "d", consequences: "q" };
  const ok = await makeADR({ ...base, status: "deprecated", deprecation_reason: "old" });
  assert.equal(ok.status, "deprecated");
  assert.equal(ok.deprecation_reason, "old");
  assert.equal(ok.review_after, null); // lifecycle fields default to inactive
  assert.deepEqual([...(ok.components ?? [])], []);
  await assert.rejects(makeADR({ ...base, status: "bogus" as never }), /validation/i);
});

// ── hydrate filter ────────────────────────────────────────────────────────────

const DAY = 86_400_000;

test("partitionDecisions drops deprecated/superseded and diverts lapsed ADRs to needsReview", () => {
  const now = new Date();
  const hits: Record<string, unknown>[] = [
    { id: "0001", title: "Active", status: "accepted" },
    { id: "0002", title: "Dead", status: "deprecated" },
    { id: "0003", title: "Replaced", status: "superseded" },
    { id: "0004", title: "Stale", status: "accepted", review_after: new Date(now.getTime() - DAY) },
    { id: "0005", title: "Fresh TTL", status: "accepted", review_after: new Date(now.getTime() + DAY) },
  ];
  const { active, needsReview } = partitionDecisions(hits, now);
  assert.deepEqual(active.map((d) => d.id), ["0001", "0005"]); // future review_after stays active
  assert.deepEqual(needsReview.map((e) => e.id), ["0004"]);
  assert.equal(needsReview[0].title, "Stale");
});

test("hydrate excludes deprecated/superseded/lapsed ADRs and reports needs_review", async () => {
  const now = Date.now();
  const hits = [
    { id: "0001", title: "Active", decision: "keep this", status: "accepted" },
    { id: "0002", title: "Dead", decision: "old path", status: "deprecated" },
    { id: "0003", title: "Replaced", decision: "older path", status: "superseded" },
    { id: "0004", title: "Stale", decision: "stale path", status: "accepted", review_after: new Date(now - DAY) },
  ];
  const fakeStore = {
    vectorSearch: async () => [],
    textSearch: async (collection: string) => (collection === "decisions" ? hits : []),
    db: { collection: () => ({ find: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
  } as unknown as MemoryStore;

  const res = await hydrate("p", "which api style?", {
    store: fakeStore, memory: false, conventions: false, repomap: false, vector: false,
  });
  assert.match(res.preamble, /ADR 0001 — Active/);
  assert.doesNotMatch(res.preamble, /ADR 0002/);
  assert.doesNotMatch(res.preamble, /ADR 0003/);
  assert.doesNotMatch(res.preamble, /ADR 0004/);
  // The lapsed ADR is NOT silent: it surfaces as needs_review + a one-line pointer.
  assert.deepEqual(res.needs_review.map((e) => e.id), ["0004"]);
  assert.match(res.preamble, /pendientes de revisión.*0004/);
});

// ── curation proposals ────────────────────────────────────────────────────────

test("isReviewOverdue: past → true, future/null/garbage → false", () => {
  const now = new Date();
  assert.equal(isReviewOverdue(new Date(now.getTime() - DAY), now), true);
  assert.equal(isReviewOverdue(new Date(now.getTime() + DAY), now), false);
  assert.equal(isReviewOverdue(null, now), false);
  assert.equal(isReviewOverdue("not-a-date", now), false);
});

test("titleSimilarity: identical token sets → 1, disjoint → 0", () => {
  assert.equal(titleSimilarity("Adopt PostgreSQL for analytics", "adopt postgresql for analytics"), 1);
  assert.equal(titleSimilarity("Alpha beta", "gamma delta"), 0);
});

test("proposeDeprecationsFrom flags the three criteria and skips inactive ADRs", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const rows = [
    // (a) superseded_by populated but status never flipped
    { id: "0001", title: "Message queue selection", status: "accepted", superseded_by: "0004" },
    // (b) soft TTL lapsed
    { id: "0002", title: "Cache invalidation policy", status: "accepted", review_after: new Date("2026-01-01T00:00:00Z") },
    // (c) later ADR with a near-identical title
    { id: "0003", title: "Adopt PostgreSQL for analytics", status: "accepted" },
    { id: "0004", title: "Event bus over message queue", status: "accepted" },
    { id: "0005", title: "Adopt PostgreSQL for analytics", status: "accepted" },
    // already inactive → never re-proposed
    { id: "0006", title: "Old thing", status: "deprecated", superseded_by: "0004" },
    { id: "0007", title: "Older thing", status: "superseded", review_after: new Date("2025-01-01T00:00:00Z") },
  ];
  const proposals = proposeDeprecationsFrom(rows, now);
  const byId = new Map(proposals.map((p) => [p.id, p]));

  assert.match(byId.get("0001")?.reason ?? "", /superseded_by 0004/);
  assert.match(byId.get("0002")?.reason ?? "", /review_after lapsed/);
  assert.match(byId.get("0003")?.reason ?? "", /similar to later ADR 0005/);
  assert.ok(!byId.has("0005")); // the LATER twin is the survivor, not a candidate
  assert.ok(!byId.has("0006"));
  assert.ok(!byId.has("0007"));
});
