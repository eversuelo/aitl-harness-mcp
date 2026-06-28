import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "mongodb";
import { ADR_CONTENT_FIELDS, archiveAndBumpVersion, contentChanged } from "./versioning.js";

/** In-memory fake of the two collections archiveAndBumpVersion touches. */
function fakeDb() {
  const store: Record<string, Record<string, unknown>[]> = {};
  const coll = (name: string) => (store[name] ??= []);
  const db = {
    collection(name: string) {
      return {
        async findOne(query: Record<string, unknown>) {
          return (
            coll(name).find((d) => Object.entries(query).every(([k, v]) => d[k] === v)) ?? null
          );
        },
        async insertOne(doc: Record<string, unknown>) {
          coll(name).push(doc);
          return { insertedId: coll(name).length };
        },
      };
    },
  } as unknown as Db;
  return { db, store };
}

test("contentChanged detects only meaningful field changes", () => {
  const a = { title: "x", decision: "d", status: "accepted", updated_at: new Date(1) };
  const b = { title: "x", decision: "d", status: "accepted", updated_at: new Date(2) };
  assert.equal(contentChanged(a, b, ADR_CONTENT_FIELDS), false); // only timestamp differs
  assert.equal(contentChanged(a, { ...b, decision: "d2" }, ADR_CONTENT_FIELDS), true);
});

test("first write → version 1, no history snapshot", async () => {
  const { db, store } = fakeDb();
  const next: Record<string, unknown> = { project: "p", id: "0001", title: "T", context: "c", decision: "d", consequences: "", status: "accepted" };
  // seed live collection AFTER archiving (mimics real upsert order isn't needed here)
  const res = await archiveAndBumpVersion({
    db, kind: "decision", liveCollection: "decisions", historyCollection: "decisions_history",
    query: { project: "p", id: "0001" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0001",
  });
  assert.equal(res.version, 1);
  assert.equal(res.changed, true);
  assert.equal((store.decisions_history ?? []).length, 0);
  assert.equal(next.version, 1);
});

test("changed write → archives prior @v1 (by its author), bumps live to v2", async () => {
  const { db, store } = fakeDb();
  store.decisions = [{ project: "p", id: "0001", title: "T", decision: "d", status: "accepted", version: 1, actor_id: "alice", actor_role: "root" }];
  const next: Record<string, unknown> = { project: "p", id: "0001", title: "T", decision: "d2", status: "accepted" };
  const res = await archiveAndBumpVersion({
    db, kind: "decision", liveCollection: "decisions", historyCollection: "decisions_history",
    query: { project: "p", id: "0001" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0001",
    actor: { id: "bob", role: "root" },
  });
  assert.equal(res.changed, true);
  assert.equal(res.archivedVersion, 1);
  assert.equal(next.version, 2);
  assert.equal(next.actor_id, "bob"); // new version authored by bob
  const hist = store.decisions_history ?? [];
  assert.equal(hist.length, 1);
  assert.equal(hist[0].version, 1);
  assert.equal(hist[0].actor_id, "alice"); // archived snapshot attributed to its author
  assert.equal((hist[0].snapshot as Record<string, unknown>).decision, "d");
});

test("unchanged write → no snapshot, version preserved (idempotent re-sync)", async () => {
  const { db, store } = fakeDb();
  store.decisions = [{ project: "p", id: "0001", title: "T", decision: "d", consequences: "", status: "accepted", version: 3 }];
  const next: Record<string, unknown> = { project: "p", id: "0001", title: "T", decision: "d", consequences: "", status: "accepted" };
  const res = await archiveAndBumpVersion({
    db, kind: "decision", liveCollection: "decisions", historyCollection: "decisions_history",
    query: { project: "p", id: "0001" }, nextDoc: next, contentFields: ADR_CONTENT_FIELDS, ref: "0001",
  });
  assert.equal(res.changed, false);
  assert.equal(next.version, 3);
  assert.equal((store.decisions_history ?? []).length, 0);
});
