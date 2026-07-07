import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CoordEvent } from "../models/coordEvent.model.js";
import { cursorFilePath, loadCursor, projectHash, saveCursor } from "./cursor.js";
import {
  type CoordEventStore,
  emitCoordEvent,
  formatCoordEvent,
  normalizeSince,
  pollEvents,
  recordCoordNote,
} from "./events.js";

/** In-memory CoordEventStore (same contract as the Mongo one: strictly-after, asc, limited). */
function fakeEventStore(initial: CoordEvent[] = []): CoordEventStore & { docs: CoordEvent[] } {
  const docs = initial.map((d) => ({ ...d }));
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
const at = (iso: string): Date => new Date(iso);

const evt = (type: CoordEvent["type"], created: string, extra: Partial<CoordEvent> = {}): CoordEvent => ({
  project: P,
  type,
  task_key: null,
  actor_id: null,
  payload: {},
  created_at: at(created),
  ...extra,
});

test("emitCoordEvent fills defaults and persists; validation rejects unknown types", async () => {
  const store = fakeEventStore();
  const doc = await emitCoordEvent({ project: P, type: "claim", taskKey: "T1", actorId: "alice" }, store);
  assert.equal(store.docs.length, 1);
  assert.equal(doc.type, "claim");
  assert.equal(doc.task_key, "T1");
  assert.deepEqual(doc.payload, {});
  assert.ok(doc.created_at instanceof Date);

  await assert.rejects(
    emitCoordEvent({ project: P, type: "nonsense" as never }, store),
    /nonsense/,
  );
});

test("pollEvents: incremental — since returns only newer events, cursor chains without repeats", async () => {
  const store = fakeEventStore([
    evt("claim", "2026-07-06T12:00:00Z", { actor_id: "alice", task_key: "T1" }),
    evt("release", "2026-07-06T12:05:00Z", { actor_id: "alice", task_key: "T1" }),
    evt("decision", "2026-07-06T12:10:00Z", { payload: { id: "0054", title: "x" } }),
  ]);

  const first = await pollEvents(P, {}, store);
  assert.equal(first.count, 3);
  assert.deepEqual(first.cursor, at("2026-07-06T12:10:00Z"));

  // Second poll from the returned cursor → nothing new, cursor stays put.
  const second = await pollEvents(P, { since: first.cursor }, store);
  assert.equal(second.count, 0);
  assert.deepEqual(second.cursor, first.cursor);

  // A new event arrives → only it comes back, cursor advances.
  await store.insert(evt("note", "2026-07-06T12:15:00Z", { actor_id: "bob", payload: { text: "hola" } }));
  const third = await pollEvents(P, { since: second.cursor }, store);
  assert.equal(third.count, 1);
  assert.equal(third.events[0].type, "note");
  assert.deepEqual(third.cursor, at("2026-07-06T12:15:00Z"));
});

test("pollEvents: accepts an ISO string since, enforces the limit, rejects junk", async () => {
  const store = fakeEventStore([
    evt("claim", "2026-07-06T12:00:00Z"),
    evt("claim", "2026-07-06T12:01:00Z"),
    evt("claim", "2026-07-06T12:02:00Z"),
  ]);

  const res = await pollEvents(P, { since: "2026-07-06T12:00:00Z", limit: 1 }, store);
  assert.equal(res.count, 1);
  assert.deepEqual(res.cursor, at("2026-07-06T12:01:00Z"));

  await assert.rejects(pollEvents(P, { since: "not-a-date" }, store), /invalid 'since'/);
  assert.equal(normalizeSince(undefined), null);
  assert.deepEqual(normalizeSince("2026-07-06T12:00:00Z"), at("2026-07-06T12:00:00Z"));
});

test("pollEvents: empty store with no since → cursor null (caller keeps its default window)", async () => {
  const res = await pollEvents(P, {}, fakeEventStore());
  assert.equal(res.count, 0);
  assert.equal(res.cursor, null);
});

test("recordCoordNote is best-effort: a broken store yields {ok:false}, never a throw", async () => {
  const broken: CoordEventStore = {
    async insert() {
      throw new Error("coord_events down");
    },
    async listSince() {
      return [];
    },
  };
  assert.deepEqual(await recordCoordNote(P, "decision", { id: "0054", title: "t" }, { store: broken }), { ok: false });

  const store = fakeEventStore();
  assert.deepEqual(await recordCoordNote(P, "decision", { id: "0054", title: "t" }, { store, actorId: "agent:x" }), {
    ok: true,
  });
  assert.equal(store.docs[0].type, "decision");
  assert.equal(store.docs[0].actor_id, "agent:x");
});

test("formatCoordEvent renders one compact line per event type", () => {
  const expires = "2026-07-06T12:45:00Z";
  const hh = new Date(expires).toTimeString().slice(0, 5); // local time of the fixed instant

  assert.equal(
    formatCoordEvent(evt("claim", "2026-07-06T12:00:00Z", { actor_id: "fulanito", task_key: "T3", payload: { scope: "backend", expires_at: expires } })),
    `[claim] fulanito tomó T3 [backend] (expira ${hh})`,
  );
  assert.equal(
    formatCoordEvent(evt("expire_reclaim", "2026-07-06T12:00:00Z", { actor_id: "bob", task_key: "T3", payload: { reclaimed_from: "alice", expires_at: expires } })),
    `[expire_reclaim] bob reclamó T3 (antes alice, expira ${hh})`,
  );
  assert.equal(
    formatCoordEvent(evt("release", "2026-07-06T12:00:00Z", { actor_id: "alice", task_key: "T3", payload: { outcome: "done" } })),
    "[release] alice soltó T3 (done)",
  );
  assert.equal(
    formatCoordEvent(evt("decision", "2026-07-06T12:00:00Z", { payload: { id: "0054", title: "Coordinación mínima" } })),
    "[decision] nuevo ADR 0054: Coordinación mínima",
  );
  assert.equal(
    formatCoordEvent(evt("note", "2026-07-06T12:00:00Z", { actor_id: "bob", payload: { text: "hola equipo" } })),
    "[note] bob: hola equipo",
  );
  // Degrades gracefully without payload/actor.
  assert.equal(formatCoordEvent(evt("claim", "2026-07-06T12:00:00Z")), "[claim] alguien tomó (sin task) (expira ?)");
});

// ── poll cursor persistence (~/.aitl/coord-cursor-<hash>.json) ────────────────

test("cursor: save/load roundtrip in an isolated dir; missing or corrupt → null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aitl-coord-cursor-"));
  try {
    assert.equal(loadCursor(P, dir), null); // nothing saved yet

    const cursor = at("2026-07-06T12:10:00Z");
    saveCursor(P, cursor, dir);
    assert.deepEqual(loadCursor(P, dir), cursor);

    // File name derives from the project hash; content keeps the plaintext project.
    const path = cursorFilePath(P, dir);
    assert.ok(path.endsWith(`coord-cursor-${projectHash(P)}.json`));
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    assert.equal(raw.project, P);
    assert.equal(raw.cursor, cursor.toISOString());

    // Distinct projects get distinct files.
    assert.notEqual(cursorFilePath("other/project", dir), path);

    // Corrupt file → null, never a throw.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{ not json", "utf-8");
    assert.equal(loadCursor(P, dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
