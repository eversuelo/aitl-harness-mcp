/**
 * Orchestrator — Pillar 2: a "thin" master that fans out to parallel sub-agents.
 *
 * The orchestrator itself runs NO tool loop. It (1) decomposes a master task into
 * independent subtasks (explicitly provided, or planned by the model), (2) launches one
 * `runAgent` per subtask IN PARALLEL — each gets its own fresh ContextManager by
 * construction, so their contexts never bleed into each other — and (3) synthesizes the
 * sub-results into one coherent answer. Everything persists to the same MongoDB
 * (shared memory bank), and the orchestration is itself a durable run.
 */

import { randomUUID } from "node:crypto";
import { ensureMongoose } from "../db/mongoose.js";
import { makeEvent } from "../models/event.model.js";
import { RunModel, makeRun } from "../models/run.model.js";
import { MemoryStore } from "../memory/store.js";
import { type Provider, getProvider } from "../providers/base.js";
import { type RunAgentOpts, type RunAgentResult, runAgent } from "./graph.js";

export interface OrchestrateOpts {
  provider?: Provider;
  store?: MemoryStore;
  /** Explicit subtasks. If omitted and `plan !== false`, the model decomposes the task. */
  tasks?: string[];
  /** Cap on parallel sub-agents (default 4). */
  maxSubagents?: number;
  /** Options forwarded to every sub-agent `runAgent` call. */
  subAgentOpts?: Partial<RunAgentOpts>;
  /** System prompt used for the final synthesis step. */
  system?: string;
  /** Let the model decompose the task when no `tasks` are given (default true). */
  plan?: boolean;
}

export interface SubAgentOutcome {
  run_id: string | null;
  task: string;
  final_text: string;
  status: "done" | "error";
}

export interface OrchestrateResult {
  run_id: string;
  final_text: string;
  subagents: SubAgentOutcome[];
}

/** Ask the model to split a task into independent, parallelizable subtasks. */
async function planSubtasks(master: string, provider: Provider, max: number): Promise<string[]> {
  const out = await provider.complete(
    `Decompose the following task into at most ${max} INDEPENDENT subtasks that can run in ` +
      "parallel. Return ONE subtask per line — no numbering, no preamble, no blank lines.\n\n" +
      `TASK:\n${master}`,
  );
  return out
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Run the master task by fanning out to parallel sub-agents, then synthesizing.
 */
export async function orchestrate(
  master: string,
  project: string,
  opts: OrchestrateOpts = {},
): Promise<OrchestrateResult> {
  const provider = opts.provider ?? (await getProvider());
  const store = opts.store ?? new MemoryStore();
  const max = opts.maxSubagents ?? 4;

  const runId = randomUUID();
  const run = makeRun({ project, model: provider.name, harness_config: { role: "orchestrator" } });
  await ensureMongoose();
  await RunModel.create({ ...run, _id: runId });

  // 1. Decide the subtasks.
  let tasks =
    opts.tasks?.slice(0, max) ??
    (opts.plan !== false ? await planSubtasks(master, provider, max) : [master]);
  if (tasks.length === 0) tasks = [master];

  // 2. Fan out: one sub-agent per subtask, in parallel, each with a fresh ContextManager.
  await Promise.all(
    tasks.map((task, i) =>
      store.logEvent(
        makeEvent({ project, run_id: runId, type: "spawn", payload: { index: i, task: task.slice(0, 200) } }),
      ),
    ),
  );
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      runAgent(task, project, {
        provider,
        store,
        summarize: false, // the orchestrator writes the single session summary
        ...opts.subAgentOpts,
      }),
    ),
  );
  const subagents: SubAgentOutcome[] = settled.map((s, i) => {
    if (s.status === "fulfilled") {
      const r = s.value as RunAgentResult;
      return { run_id: r.run_id, task: tasks[i], final_text: r.final_text, status: "done" };
    }
    return {
      run_id: null,
      task: tasks[i],
      final_text: `[sub-agent failed] ${String((s.reason as Error)?.message ?? s.reason).slice(0, 300)}`,
      status: "error",
    };
  });

  // 3. Synthesize the sub-results into one answer.
  const synthInput = [
    `You orchestrated ${subagents.length} sub-agents to solve this task:`,
    master,
    "",
    ...subagents.map((r, i) => `## Sub-agent ${i + 1} — ${r.task}\n${r.final_text}`),
    "",
    "Synthesize their results into a single, coherent final answer to the original task.",
  ].join("\n");
  const final = (await provider.complete(synthInput, { system: opts.system })).trim();
  await store.logEvent(
    makeEvent({
      project,
      run_id: runId,
      type: "synthesis",
      payload: { subagents: subagents.length, errors: subagents.filter((r) => r.status === "error").length },
    }),
  );

  await ensureMongoose();
  await RunModel.updateOne({ _id: runId }, { $set: { status: "done", ended_at: new Date() } });

  return { run_id: runId, final_text: final, subagents };
}
