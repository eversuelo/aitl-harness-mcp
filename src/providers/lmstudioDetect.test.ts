import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectLmStudioModel,
  fetchLmStudioModels,
  loadedChatModels,
  nativeModelsUrl,
  planLmStudioDetection,
  type LmStudioModelInfo,
} from "./lmstudioDetect.js";

const M = (over: Partial<LmStudioModelInfo>): LmStudioModelInfo => ({
  id: "m",
  type: "llm",
  state: "not-loaded",
  ...over,
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test("nativeModelsUrl strips the /v1 suffix (and trailing slashes) before /api/v0", () => {
  assert.equal(nativeModelsUrl("http://localhost:1234/v1"), "http://localhost:1234/api/v0/models");
  assert.equal(nativeModelsUrl("http://localhost:1234/v1/"), "http://localhost:1234/api/v0/models");
  assert.equal(nativeModelsUrl("http://10.0.0.5:1234"), "http://10.0.0.5:1234/api/v0/models");
  // /v1 only strips as a suffix — a path segment elsewhere is preserved.
  assert.equal(nativeModelsUrl("https://gw.local/v1/proxy"), "https://gw.local/v1/proxy/api/v0/models");
});

test("loadedChatModels keeps loaded llm/vlm, drops embeddings and not-loaded", () => {
  const models = [
    M({ id: "chat", state: "loaded" }),
    M({ id: "vision", type: "vlm", state: "loaded" }),
    M({ id: "old-server", type: undefined, state: "loaded" }), // sin `type` cuenta como chat
    M({ id: "embed", type: "embeddings", state: "loaded" }),
    M({ id: "cold" }),
  ];
  assert.deepEqual(
    loadedChatModels(models).map((m) => m.id),
    ["chat", "vision", "old-server"],
  );
});

test("planLmStudioDetection: exactly one loaded → updates with the ACTUAL loaded context", () => {
  const plan = planLmStudioDetection([
    M({ id: "mistralai/ministral-3-3b", state: "loaded", max_context_length: 262144, loaded_context_length: 20000 }),
    M({ id: "qwen/qwen3-4b-2507" }),
  ]);
  assert.ok(plan.ok);
  assert.deepEqual(plan.updates, {
    LMSTUDIO_MODEL: "mistralai/ministral-3-3b",
    LMSTUDIO_MAX_CONTEXT: "20000",
  });
});

test("planLmStudioDetection: loaded_context_length missing → LMSTUDIO_MAX_CONTEXT omitted", () => {
  const plan = planLmStudioDetection([M({ id: "a", state: "loaded" })]);
  assert.ok(plan.ok);
  assert.deepEqual(plan.updates, { LMSTUDIO_MODEL: "a" });
});

test("planLmStudioDetection: none loaded / ambiguous / pick not loaded", () => {
  assert.deepEqual(planLmStudioDetection([M({ id: "a" })]), {
    ok: false,
    reason: "none_loaded",
    loaded: [],
  });

  const two = [M({ id: "a", state: "loaded" }), M({ id: "b", state: "loaded" })];
  const ambiguous = planLmStudioDetection(two);
  assert.ok(!ambiguous.ok && ambiguous.reason === "ambiguous" && ambiguous.loaded.length === 2);

  const missPick = planLmStudioDetection(two, "c");
  assert.ok(!missPick.ok && missPick.reason === "pick_not_loaded");

  // pick resolves the ambiguity — never a silent first-of-list.
  const picked = planLmStudioDetection(two, "b");
  assert.ok(picked.ok && picked.model.id === "b");
});

test("fetchLmStudioModels parses data[], keeping only entries with a string id", async () => {
  const models = await fetchLmStudioModels("http://x/v1", {
    fetchImpl: fakeFetch(200, { data: [{ id: "a", state: "loaded" }, { nope: true }] }),
  });
  assert.deepEqual(models.map((m) => m.id), ["a"]);
});

test("fetchLmStudioModels fails actionably on HTTP errors, bad bodies and network errors", async () => {
  await assert.rejects(
    () => fetchLmStudioModels("http://x/v1", { fetchImpl: fakeFetch(500, {}) }),
    /HTTP 500/,
  );
  await assert.rejects(
    () => fetchLmStudioModels("http://x/v1", { fetchImpl: fakeFetch(200, { data: "nope" }) }),
    /respuesta inesperada/,
  );
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchLmStudioModels("http://x/v1", { fetchImpl: down }),
    /lms server start/,
  );
});

test("detectLmStudioModel: single loaded model resolves; zero/many throw with next steps", async () => {
  const one = await detectLmStudioModel("http://x/v1", {
    fetchImpl: fakeFetch(200, { data: [M({ id: "solo", state: "loaded" })] }),
  });
  assert.equal(one.id, "solo");

  await assert.rejects(
    () => detectLmStudioModel("http://x/v1", { fetchImpl: fakeFetch(200, { data: [M({ id: "cold" })] }) }),
    /ningún modelo cargado/,
  );
  await assert.rejects(
    () =>
      detectLmStudioModel("http://x/v1", {
        fetchImpl: fakeFetch(200, { data: [M({ id: "a", state: "loaded" }), M({ id: "b", state: "loaded" })] }),
      }),
    /aitl models --detect/,
  );
});
