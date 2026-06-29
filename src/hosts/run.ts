/**
 * runOnHost — drive an external agent host with the harness wrapped around it.
 *
 * The host (Codex / Claude Code / Antigravity) runs its own agent loop; the harness adds
 * the durable layer: it hydrates project context into the prompt, records the run as a
 * first-class `run` with transcript + events, captures the host's measured metrics
 * (tokens/cost/turns — thesis metric #7), persists the prompt to the durable history
 * (auto-classifying specs), and synthesizes spec runs into durable memory. This is the
 * "cognitive system" running OVER another agent, rather than driving a raw model itself.
 */

import { randomUUID } from "node:crypto";
import { hydrate } from "../memory/lifecycle.js";
import { makeEvent, makeMessage, makeRun } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";
import { PromptStore } from "../prompts/store.js";
import { classifySpec } from "../specs/classify.js";
import { synthesizeSpecRun } from "../specs/synthesis.js";
import { type HostAdapter, getHost } from "./base.js";

export interface RunOnHostOpts {
  store?: MemoryStore;
  host: string | HostAdapter;
  cwd?: string;
  timeoutMs?: number;
  /** Inject the project's durable context into the prompt (default true). */
  hydrate?: boolean;
  /** Persist the prompt to the durable prompt history (default true). */
  recordPrompt?: boolean;
  /** Synthesize spec-classified runs into a durable memory doc (default true). */
  synthesizeSpec?: boolean;
}

export interface RunOnHostResult {
  run_id: string;
  host: string;
  final_text: string;
  exit_code: number;
  status: "done" | "error";
  /** Measured token usage (zeros when the host emits no structured output). */
  token_usage: { input: number; output: number };
  /** Host telemetry (cost_usd, num_turns, duration_ms…) when available. */
  meta?: Record<string, unknown> | null;
  /** Whether the prompt was auto-classified as a spec (SDD input). */
  spec: boolean;
  /** Slug of the spec↔task synthesis doc, when a spec run was synthesized. */
  synthesis_slug?: string;
  /** Id of the durable prompt record, when one was written. */
  prompt_id?: string;
}

export async function runOnHost(
  prompt: string,
  project: string,
  opts: RunOnHostOpts,
): Promise<RunOnHostResult> {
  const store = opts.store ?? new MemoryStore();
  const host = typeof opts.host === "string" ? getHost(opts.host) : opts.host;
  const spec = classifySpec(prompt);

  const runId = randomUUID();
  const run = makeRun({
    project,
    model: `host:${host.name}`,
    harness_config: { role: "host", host: host.name, spec: spec.isSpec },
  });
  await store.db.collection("runs").insertOne({ ...run, _id: runId as never });
  await store.appendMessage(makeMessage({ project, run_id: runId, idx: 0, role: "user", content: prompt }));

  // Hydrate the host's prompt with the project's durable context (the harness's value-add).
  let fullPrompt = prompt;
  if (opts.hydrate !== false) {
    try {
      const { preamble, sections } = await hydrate(project, prompt, { store });
      if (preamble) fullPrompt = `${preamble}\n\n---\n\n${prompt}`;
      await store.logEvent(makeEvent({ project, run_id: runId, type: "hydrate", payload: { host: host.name, ...sections } }));
    } catch {
      // hydration is best-effort
    }
  }
  await store.logEvent(makeEvent({ project, run_id: runId, type: "spawn", payload: { host: host.name, spec: spec.isSpec } }));

  // Persist the prompt to the durable history with the run linkage; spec-classified prompts
  // are tagged `spec` so they surface as SDD inputs. Metadata is enriched after the run.
  let promptId: string | undefined;
  const recordPrompt = async (extra: Record<string, unknown>): Promise<void> => {
    if (opts.recordPrompt === false) return;
    try {
      const rec = await new PromptStore(store.db).add({
        project,
        prompt,
        source: "host",
        model: `host:${host.name}`,
        run_id: runId,
        tags: spec.isSpec ? ["spec", "sdd"] : ["task"],
        metadata: { host: host.name, spec: spec.isSpec, spec_signals: spec.signals, ...extra },
      });
      promptId = rec.id;
    } catch {
      // prompt history is best-effort telemetry; never fail a run over it
    }
  };

  let result: { text: string; raw: string; exitCode: number; usage?: { input: number; output: number }; meta?: Record<string, unknown> };
  try {
    result = await host.runTask(fullPrompt, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 500);
    await store.db
      .collection("runs")
      .updateOne({ _id: runId as never }, { $set: { status: "error", ended_at: new Date(), error: message } });
    await store.logEvent(makeEvent({ project, run_id: runId, type: "error", payload: { host: host.name, message } }));
    await recordPrompt({ status: "error", error: message });
    throw err;
  }

  const status: "done" | "error" = result.exitCode === 0 ? "done" : "error";
  const usage = result.usage ?? { input: 0, output: 0 };
  const meta = result.meta ?? null;
  await store.appendMessage(
    makeMessage({ project, run_id: runId, idx: 1, role: "assistant", content: result.text, tokens: usage.output }),
  );
  await store.db.collection("runs").updateOne(
    { _id: runId as never },
    {
      $set: {
        status,
        ended_at: new Date(),
        token_usage: usage,
        // num_turns is the host's loop-iteration analog; surface it under `iters` for run-show.
        iters: typeof meta?.num_turns === "number" ? meta.num_turns : null,
        host_meta: meta,
        spec: spec.isSpec,
      },
    },
  );

  // Synthesize spec runs: join the spec, the outcome, and the metrics into durable memory.
  let synthesisSlug: string | undefined;
  if (spec.isSpec && opts.synthesizeSpec !== false) {
    try {
      const res = await synthesizeSpecRun({
        project,
        runId,
        spec: prompt,
        outcome: result.text,
        signals: spec.signals,
        usage,
        meta,
        status,
        host: host.name,
        store,
      });
      synthesisSlug = res.slug;
      await store.logEvent(
        makeEvent({ project, run_id: runId, type: "synthesis", payload: { slug: res.slug, kind: "spec", host: host.name } }),
      );
    } catch {
      // synthesis is best-effort; never fail a completed run over it
    }
  }

  await recordPrompt({
    status,
    exit_code: result.exitCode,
    tokens: { input: usage.input, output: usage.output, total: usage.input + usage.output },
    cost_usd: meta?.cost_usd ?? null,
    num_turns: meta?.num_turns ?? null,
    synthesis_slug: synthesisSlug ?? null,
  });

  return {
    run_id: runId,
    host: host.name,
    final_text: result.text,
    exit_code: result.exitCode,
    status,
    token_usage: usage,
    meta,
    spec: spec.isSpec,
    synthesis_slug: synthesisSlug,
    prompt_id: promptId,
  };
}
