/**
 * Plan-council E2E over FAKE hosts — no network, no real model, no Mongo.
 *
 * The fixtures in test/fixtures/council/ are local executables wired in via the
 * AITL_HOST_CMD_<HOST> overrides (the same seam production uses): they read the prompt
 * on stdin, detect the phase from the AITL-COUNCIL-PHASE marker, and emit canned JSON
 * (or garbage) on stdout. Telemetry is an in-memory fake of the CouncilTelemetryStore
 * seam, so nothing touches the DB.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HostClientAdapter } from "./adapters.js";
import { type CouncilTelemetryStore, runCouncil } from "./orchestrator.js";

const fixture = (name: string): string => {
  const p = fileURLToPath(new URL(`../../test/fixtures/council/${name}`, import.meta.url));
  chmodSync(p, 0o755); // the exec bit must survive any checkout/copy
  return p;
};

const identity = <T>(items: T[]): T[] => [...items];

/** Wire the three host names to fixture scripts; restores the env afterwards. */
async function withFakeHosts(
  cmds: { codex: string; antigravity: string; "claude-code": string },
  callsFile: string | null,
  fn: () => Promise<void>,
): Promise<void> {
  const vars: Record<string, string | null> = {
    AITL_HOST_CMD_CODEX: cmds.codex,
    AITL_HOST_CMD_ANTIGRAVITY: cmds.antigravity,
    AITL_HOST_CMD_CLAUDE_CODE: cmds["claude-code"],
    AITL_COUNCIL_CALLS_FILE: callsFile,
  };
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface FakeTelemetry extends CouncilTelemetryStore {
  runs: { id: string; args: Record<string, unknown>; patches: Record<string, unknown>[] }[];
  events: { type: string; run_id: string | null; payload: Record<string, unknown> }[];
  memories: { slug: string; tags: string[]; body: string }[];
}

function fakeTelemetry(): FakeTelemetry {
  const t: FakeTelemetry = {
    runs: [],
    events: [],
    memories: [],
    async createRun(args) {
      const id = `e2e-run-${String(t.runs.length + 1).padStart(4, "0")}`;
      t.runs.push({ id, args: args as unknown as Record<string, unknown>, patches: [] });
      return id;
    },
    async updateRun(runId, patch) {
      t.runs.find((r) => r.id === runId)?.patches.push(patch);
    },
    async logEvent(ev) {
      t.events.push({ type: ev.type, run_id: ev.run_id, payload: ev.payload });
    },
    async saveVerdictMemory(doc) {
      t.memories.push({ slug: doc.slug, tags: doc.tags, body: doc.body });
      return doc.slug;
    },
  };
  return t;
}

const council = (tel: CouncilTelemetryStore) => ({
  project: "proj",
  task: "diseñar el plan-council",
  proponents: [HostClientAdapter.forHost("codex"), HostClientAdapter.forHost("antigravity")],
  judge: HostClientAdapter.forHost("claude-code"),
  telemetry: tel,
  shuffle: identity,
});

test("council E2E feliz: 2 hosts proponen, se critican en anónimo y el juez emite veredicto", async () => {
  const calls = join(mkdtempSync(join(tmpdir(), "aitl-council-")), "calls.log");
  const tel = fakeTelemetry();
  await withFakeHosts(
    { codex: fixture("fake-proposer.mjs"), antigravity: fixture("fake-proposer.mjs"), "claude-code": fixture("fake-judge.mjs") },
    calls,
    async () => {
      const result = await runCouncil(council(tel));

      // Proposals: anonymous labels in the (identity-)shuffled proponent order.
      assert.deepEqual(result.proposals.map((p) => [p.label, p.client_id]), [
        ["A", "codex"],
        ["B", "antigravity"],
      ]);
      assert.deepEqual(result.authors, { A: "codex", B: "antigravity" });
      assert.equal(result.no_votes.length, 0);

      // Each critic critiqued exactly the OTHER proposal (never its own).
      assert.deepEqual(
        result.critiques.map((c) => [c.critic_id, c.critique.target]).sort(),
        [["antigravity", "A"], ["codex", "B"]],
      );

      // Deterministic rubric aggregate of the canned scores:
      // 0.3*4 + 0.2*4 + 0.2*3 + 0.15*5 + 0.15*4 = 3.95 for both proposals.
      assert.ok(Math.abs(result.rubric.scores.A.total - 3.95) < 1e-9);
      assert.ok(Math.abs(result.rubric.scores.B.total - 3.95) < 1e-9);

      // Verdict from the (fake) claude-code judge; its tokens are the only measured usage.
      assert.equal(result.verdict.winner, "A");
      assert.match(result.verdict.synthesis, /Plan combinado/);
      assert.deepEqual(result.token_usage, { input: 10, output: 5 });

      // Telemetry: run kind council + one event per client/phase + the verdict event.
      assert.equal(tel.runs.length, 1);
      assert.equal(tel.runs[0].args.model, "council:codex+antigravity");
      assert.equal((tel.runs[0].args.harness_config as Record<string, unknown>).kind, "council");
      const types = tel.events.map((e) => e.type);
      assert.deepEqual(
        types.filter((t) => t === "council_propose").length,
        2,
      );
      assert.equal(types.filter((t) => t === "council_critique").length, 2);
      assert.deepEqual(types.filter((t) => t === "council_no_vote"), []);
      const verdictEv = tel.events.find((e) => e.type === "council_verdict");
      assert.ok(verdictEv);
      assert.equal(verdictEv.payload.winner, "A");
      assert.equal(verdictEv.payload.winner_client, "codex");
      assert.deepEqual(verdictEv.payload.tokens, { input: 10, output: 5 });
      for (const ev of tel.events) {
        assert.equal(ev.run_id, "e2e-run-0001");
        assert.equal(typeof ev.payload.duration_ms, "number");
      }

      // Verdict persisted as a design memory linked to the run.
      assert.equal(result.memory_slug, "council-verdict-e2e-run-");
      assert.equal(tel.memories.length, 1);
      assert.ok(tel.memories[0].tags.includes("council"));
      assert.match(tel.memories[0].body, /Ganador: A \(codex\)/);
      const done = tel.runs[0].patches.at(-1) as Record<string, unknown>;
      assert.equal(done.status, "done");
      assert.equal((done.council as Record<string, unknown>).winner, "A");

      // The hosts ran in READ-ONLY mode: the harness passed the spec's readonly argv.
      const lines = readFileSync(calls, "utf8").trim().split("\n");
      assert.ok(lines.some((l) => l === "propose exec --sandbox read-only -"), `codex argv: ${lines.join(" | ")}`);
      assert.ok(
        lines.some((l) => l === "judge -p --output-format json --permission-mode plan"),
        `judge argv: ${lines.join(" | ")}`,
      );
    },
  );
});

test("council E2E sin-voto con quórum: un crítico emite basura dos veces → retry → no-vote y el consejo continúa", async () => {
  const calls = join(mkdtempSync(join(tmpdir(), "aitl-council-")), "calls.log");
  const tel = fakeTelemetry();
  await withFakeHosts(
    {
      codex: fixture("fake-proposer.mjs"),
      antigravity: fixture("fake-critic-garbage.mjs"),
      "claude-code": fixture("fake-judge.mjs"),
    },
    calls,
    async () => {
      const result = await runCouncil(council(tel));

      // Both proposals survived (the garbage came in the CRITIQUE round) → quorum holds.
      assert.equal(result.proposals.length, 2);
      assert.deepEqual(result.no_votes, [
        { client_id: "antigravity", phase: "critique", round: 2, error: result.no_votes[0].error },
      ]);
      assert.match(result.no_votes[0].error, /JSON/i);

      // Only codex's critique survived; the council still reached a verdict.
      assert.deepEqual(result.critiques.map((c) => c.critic_id), ["codex"]);
      assert.equal(result.verdict.winner, "A");

      // Budget: the failing critic was invoked exactly TWICE in the critique phase
      // (base + the single repair retry) — never a third time.
      const lines = readFileSync(calls, "utf8").trim().split("\n");
      assert.equal(lines.filter((l) => l === "critique run").length, 2); // antigravity argv is `run`
      assert.equal(tel.events.filter((e) => e.type === "council_no_vote").length, 1);
      const noVote = tel.events.find((e) => e.type === "council_no_vote");
      assert.equal(noVote?.payload.client, "antigravity");
      assert.equal(noVote?.payload.phase, "critique");
    },
  );
});

test("council E2E quórum roto: un proponente de 2 emite basura dos veces → error claro y run en error", async () => {
  const calls = join(mkdtempSync(join(tmpdir(), "aitl-council-")), "calls.log");
  const tel = fakeTelemetry();
  await withFakeHosts(
    {
      codex: fixture("fake-proposer.mjs"),
      antigravity: fixture("fake-garbage.mjs"),
      "claude-code": fixture("fake-judge.mjs"),
    },
    calls,
    async () => {
      await assert.rejects(runCouncil(council(tel)), /quórum roto/);

      // The garbage proposer got its base call + one retry, then the council aborted:
      // the judge was never invoked.
      const lines = readFileSync(calls, "utf8").trim().split("\n");
      assert.equal(lines.filter((l) => l === "propose run").length, 2);
      assert.equal(lines.filter((l) => l.startsWith("judge")).length, 0);

      assert.equal(tel.events.filter((e) => e.type === "council_no_vote").length, 1);
      const errPatch = tel.runs[0].patches.at(-1) as Record<string, unknown>;
      assert.equal(errPatch.status, "error");
      assert.match(String(errPatch.error), /quórum/);
    },
  );
});
