import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DecisionModel } from "../models/decision.model.js";
import { DecisionHistoryModel } from "../models/history.model.js";
import { ADR_CONTENT_FIELDS, archiveAndBumpVersion, contentChanged } from "./versioning.js";

/**
 * In-memory stand-in for the two model statics `archiveAndBumpVersion` touches.
 * Post-Mongoose migration the function no longer accepts an injected `Db`; it reads the
 * live doc via `DecisionModel.findOne(query).lean()` and appends the prior snapshot via
 * `DecisionHistoryModel.create(...)` (kind "decision" → decisions + decisions_history).
 * The tests stub those statics and back them with local arrays, preserving the assertions.
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

  // `makeHistoryEntry` (which builds via `new DecisionHistoryModel` + async validate()) still
  // runs for real; only the persistence `create` is captured into the local array.
  mock.method(DecisionHistoryModel, "create", ((doc: Record<string, unknown>) => {
    history.push(doc);
    return Promise.resolve(doc);
  }) as never);

  return { live, history, restore: () => mock.restoreAll() };
}

test("contentChanged detects only meaningful field changes", () => {
  const a = { title: "x", decision: "d", status: "accepted", updated_at: new Date(1) };
  const b = { title: "x", decision: "d", status: "accepted", updated_at: new Date(2) };
  assert.equal(contentChanged(a, b, ADR_CONTENT_FIELDS), false); // only timestamp differs
  assert.equal(contentChanged(a, { ...b, decision: "d2" }, ADR_CONTENT_FIELDS), true);
});

test("first write → version 1, no history snapshot", async () => {
  const { history, restore } = stubModels();
  try {
    const next: Record<string, unknown> = { project: "p", id: "0001", title: "T", context: "c", decision: "d", consequences: "", status: "accepted" };
    const res = await archiveAndBumpVersion({
      kind: "decision",
      query: { project: "p", id: "0001" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0001",
    });
    assert.equal(res.version, 1);
    assert.equal(res.changed, true);
    assert.equal(history.length, 0);
    assert.equal(next.version, 1);
  } finally {
    restore();
  }
});

test("changed write → archives prior @v1 (by its author), bumps live to v2", async () => {
  const { history, restore } = stubModels([
    { project: "p", id: "0001", title: "T", decision: "d", status: "accepted", version: 1, actor_id: "alice", actor_role: "root" },
  ]);
  try {
    const next: Record<string, unknown> = { project: "p", id: "0001", title: "T", decision: "d2", status: "accepted" };
    const res = await archiveAndBumpVersion({
      kind: "decision",
      query: { project: "p", id: "0001" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0001",
      actor: { id: "bob", role: "root" },
    });
    assert.equal(res.changed, true);
    assert.equal(res.archivedVersion, 1);
    assert.equal(next.version, 2);
    assert.equal(next.actor_id, "bob"); // new version authored by bob
    assert.equal(history.length, 1);
    assert.equal(history[0].version, 1);
    assert.equal(history[0].actor_id, "alice"); // archived snapshot attributed to its author
    assert.equal((history[0].snapshot as Record<string, unknown>).decision, "d");
  } finally {
    restore();
  }
});

test("unchanged write → no snapshot, version preserved (idempotent re-sync)", async () => {
  const { history, restore } = stubModels([
    { project: "p", id: "0001", title: "T", decision: "d", consequences: "", status: "accepted", version: 3 },
  ]);
  try {
    const next: Record<string, unknown> = { project: "p", id: "0001", title: "T", decision: "d", consequences: "", status: "accepted" };
    const res = await archiveAndBumpVersion({
      kind: "decision",
      query: { project: "p", id: "0001" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0001",
    });
    assert.equal(res.changed, false);
    assert.equal(next.version, 3);
    assert.equal(history.length, 0);
  } finally {
    restore();
  }
});

// ── commit_sha provenance (F2) ────────────────────────────────────────────────

test("commit_sha is stamped alongside branch on the version being written", async () => {
  const { restore } = stubModels();
  try {
    const next: Record<string, unknown> = { project: "p", id: "0002", title: "T", context: "c", decision: "d", consequences: "", status: "accepted" };
    await archiveAndBumpVersion({
      kind: "decision",
      query: { project: "p", id: "0002" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0002",
      branch: "feat/x", commit_sha: "cafebabe0001",
    });
    assert.equal(next.branch, "feat/x");
    assert.equal(next.commit_sha, "cafebabe0001");
  } finally {
    restore();
  }
});

test("unchanged re-write preserves the ORIGINAL commit_sha (like branch/authorship)", async () => {
  const { history, restore } = stubModels([
    { project: "p", id: "0002", title: "T", decision: "d", consequences: "", status: "accepted", version: 2, branch: "main", commit_sha: "original000" },
  ]);
  try {
    const next: Record<string, unknown> = { project: "p", id: "0002", title: "T", decision: "d", consequences: "", status: "accepted" };
    const res = await archiveAndBumpVersion({
      kind: "decision",
      query: { project: "p", id: "0002" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0002",
      branch: "feat/y", commit_sha: "newer000",
    });
    assert.equal(res.changed, false);
    assert.equal(next.commit_sha, "original000"); // idempotent re-sync keeps provenance
    assert.equal(next.branch, "main");
    assert.equal(history.length, 0);
  } finally {
    restore();
  }
});

test("changed write archives the PRIOR commit_sha and stamps the new one on the live doc", async () => {
  const { history, restore } = stubModels([
    { project: "p", id: "0002", title: "T", decision: "d", consequences: "", status: "accepted", version: 1, branch: "main", commit_sha: "old0001" },
  ]);
  try {
    const next: Record<string, unknown> = { project: "p", id: "0002", title: "T", decision: "d2", consequences: "", status: "accepted" };
    const res = await archiveAndBumpVersion({
      kind: "decision",
      query: { project: "p", id: "0002" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0002",
      branch: "feat/z", commit_sha: "new0002",
    });
    assert.equal(res.changed, true);
    assert.equal(next.version, 2);
    assert.equal(next.commit_sha, "new0002");
    assert.equal(history.length, 1);
    assert.equal(history[0].commit_sha, "old0001"); // archived snapshot attributed to ITS commit
    assert.equal((history[0].snapshot as Record<string, unknown>).commit_sha, "old0001");
  } finally {
    restore();
  }
});
