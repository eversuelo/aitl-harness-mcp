import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostAdapter } from "./base.js";
import { runOnHost } from "./run.js";

// Bug A (ADR-0060): when Mongo is unreachable the CLI preAction sets AITL_DB_DEGRADED and
// run-host must still execute the host — persisting nothing — instead of aborting the run.
// A pre-built HostAdapter lets us exercise runOnHost with no DB and no real host process.
test("runOnHost degrades without Mongo: runs the host, persists nothing, returns metrics", async () => {
  const prev = process.env.AITL_DB_DEGRADED;
  process.env.AITL_DB_DEGRADED = "1";
  let calls = 0;
  let seenPrompt = "";
  const fakeHost: HostAdapter = {
    name: "fake",
    async runTask(prompt: string) {
      calls++;
      seenPrompt = prompt;
      return { text: `echo:${prompt}`, raw: "", exitCode: 0, usage: { input: 10, output: 5 }, meta: { cost_usd: 0.01, num_turns: 3 } };
    },
  };
  try {
    const res = await runOnHost("do a thing", "p", { host: fakeHost });
    assert.equal(calls, 1);
    assert.equal(seenPrompt, "do a thing"); // RAW prompt — no hydration preamble in degraded mode
    assert.equal(res.run_id, ""); // no durable run record was created
    assert.equal(res.status, "done");
    assert.equal(res.exit_code, 0);
    assert.equal(res.final_text, "echo:do a thing");
    assert.deepEqual(res.token_usage, { input: 10, output: 5 });
    assert.equal((res.meta as { cost_usd?: number } | null)?.cost_usd, 0.01);
  } finally {
    if (prev === undefined) delete process.env.AITL_DB_DEGRADED;
    else process.env.AITL_DB_DEGRADED = prev;
  }
});
