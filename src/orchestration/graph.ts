/**
 * The agent loop: prompt -> model -> tools -> repeat.
 *
 * `runAgent` is a fully-working, provider-agnostic loop that persists the run and
 * every turn into MongoDB (durable transcript) and respects the context budget.
 *
 * `buildGraph` wires the same loop as a LangGraph StateGraph with a MongoDB
 * checkpointer so runs are resumable/replayable. It is kept thin and lazily-imported
 * so the package works even before LangGraph internals are pinned.
 */

import { randomUUID } from "node:crypto";
import { ContextManager } from "../context/manager.js";
import { hydrate, summarizeSession } from "../memory/lifecycle.js";
import { makeEvent, makeMessage, makeRun } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";
import { routeSkills } from "../projectctx/router.js";
import { DefinitionStore } from "../projectctx/store.js";
import { type Provider, getProvider } from "../providers/base.js";
import { type ToolRegistry, defaultRegistry } from "../tools/base.js";

export interface RunAgentOpts {
  provider?: Provider;
  registry?: ToolRegistry;
  store?: MemoryStore;
  system?: string;
  maxIters?: number;
  /** Load relevant durable memory into the system prompt at session start (default true). */
  hydrate?: boolean;
  /** Inject relevant project skills into the system prompt at session start (default true). */
  skills?: boolean;
  /** Write a classified session summary to memory at session end (default true). */
  summarize?: boolean;
}

export interface RunAgentResult {
  run_id: string;
  final_text: string;
  iters: number;
  /** Slug of the session-summary memory doc written at the end, if any. */
  summary_slug?: string;
  /** Names of the project skills injected into the system prompt at start. */
  selected_skills?: string[];
}

/** Run one agent task to completion. */
export async function runAgent(
  prompt: string,
  project: string,
  opts: RunAgentOpts = {},
): Promise<RunAgentResult> {
  const provider = opts.provider ?? (await getProvider());
  const store = opts.store ?? new MemoryStore();
  const registry = opts.registry ?? defaultRegistry;
  const maxIters = opts.maxIters ?? 12;
  const ctx = new ContextManager(undefined, provider);

  const runId = randomUUID();
  const run = makeRun({ project, model: provider.name, harness_config: { max_iters: maxIters } });
  await store.db.collection("runs").insertOne({ ...run, _id: runId as never });

  // ── session start: build the system prompt from durable context ──
  // Order: recovered memory (mem_context) → relevant skills (skills_route) → base system.
  const preambles: string[] = [];
  let selectedSkills: string[] = [];
  if (opts.hydrate !== false) {
    try {
      const { preamble, count } = await hydrate(project, prompt, { store });
      if (preamble) preambles.push(preamble);
      await store.logEvent(makeEvent({ project, run_id: runId, type: "hydrate", payload: { recovered: count } }));
    } catch {
      // Hydration is best-effort; never block the run.
    }
  }
  if (opts.skills !== false) {
    try {
      const { preamble, selected } = await routeSkills(project, prompt, {
        store: new DefinitionStore("skill", store.db),
      });
      selectedSkills = selected;
      if (preamble) preambles.push(preamble);
      await store.logEvent(makeEvent({ project, run_id: runId, type: "skills_route", payload: { selected } }));
    } catch {
      // Skill routing is best-effort; never block the run.
    }
  }
  const system = [...preambles, opts.system].filter(Boolean).join("\n\n") || undefined;

  let convo: Record<string, unknown>[] = [{ role: "user", content: prompt }];
  let idx = 0;
  await store.appendMessage(
    makeMessage({ project, run_id: runId, idx, role: "user", content: prompt }),
  );

  let finalText = "";
  let it = 0;
  for (; it < maxIters; it++) {
    if (ctx.overBudget(convo)) {
      convo = await ctx.compact(convo);
      await store.logEvent(makeEvent({ project, run_id: runId, type: "compaction", payload: { iter: it } }));
    }

    const turn = await provider.chat(convo, { tools: registry.schemas(), system });
    idx += 1;
    await store.appendMessage(
      makeMessage({
        project,
        run_id: runId,
        idx,
        role: "assistant",
        content: turn.text,
        tool_calls: turn.tool_calls,
        tokens: turn.usage.output,
      }),
    );
    await store.logEvent(makeEvent({ project, run_id: runId, type: "loop_iter", payload: { iter: it } }));
    finalText = turn.text || finalText;

    if (turn.tool_calls.length === 0) break; // model is done

    convo.push({ role: "assistant", content: turn.text, tool_calls: turn.tool_calls });
    for (const call of turn.tool_calls) {
      const result = await registry.call(call.name, call.input ?? {});
      idx += 1;
      await store.appendMessage(
        makeMessage({ project, run_id: runId, idx, role: "tool", content: result }),
      );
      await store.logEvent(
        makeEvent({ project, run_id: runId, type: "tool_call", payload: { name: call.name } }),
      );
      convo.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // ── session summary: compress the run into durable memory (mem_session_summary) ──
  let summarySlug: string | undefined;
  if (opts.summarize !== false) {
    try {
      const res = await summarizeSession(project, runId, convo, { store, provider });
      if (res) {
        summarySlug = res.slug;
        await store.logEvent(
          makeEvent({ project, run_id: runId, type: "session_summary", payload: { slug: res.slug, category: res.category } }),
        );
      }
    } catch {
      // Summarization is best-effort; never fail a completed run over it.
    }
  }

  await store.db
    .collection("runs")
    .updateOne({ _id: runId as never }, { $set: { status: "done", ended_at: new Date() } });
  return {
    run_id: runId,
    final_text: finalText,
    iters: it + 1,
    summary_slug: summarySlug,
    selected_skills: selectedSkills,
  };
}

/**
 * Wire the loop as a checkpointed LangGraph StateGraph (resumable/replayable).
 * Lazily imports LangGraph + the Mongo checkpointer.
 */
export async function buildGraph(opts: { provider?: Provider; registry?: ToolRegistry } = {}) {
  const { optionalImport } = await import("../util/optional.js");
  const { StateGraph, END, Annotation } = await optionalImport("@langchain/langgraph");
  const { getCheckpointer } = await import("./checkpointer.js");

  const provider = opts.provider ?? (await getProvider());
  const registry = opts.registry ?? defaultRegistry;

  // `Annotation` is resolved lazily as `any` (optional dep), so generic type args
  // aren't available here; the reducers below carry the runtime contract instead.
  const State = Annotation.Root({
    messages: Annotation({
      reducer: (a: Record<string, unknown>[], b: Record<string, unknown>[]) => a.concat(b),
      default: () => [],
    }),
    last: Annotation(),
  });

  const agentNode = async (state: any) => {
    const turn = await provider.chat(state.messages, { tools: registry.schemas() });
    return {
      messages: [{ role: "assistant", content: turn.text, tool_calls: turn.tool_calls }],
      last: turn,
    };
  };

  const toolsNode = async (state: any) => {
    const out: Record<string, unknown>[] = [];
    for (const call of state.last?.tool_calls ?? []) {
      const result = await registry.call(call.name, call.input ?? {});
      out.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    return { messages: out };
  };

  const route = (state: any) => (state.last?.tool_calls.length ? "tools" : END);

  const graph = new StateGraph(State)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .setEntryPoint("agent")
    .addConditionalEdges("agent", route, { tools: "tools", [END]: END })
    .addEdge("tools", "agent");

  return graph.compile({ checkpointer: await getCheckpointer() });
}
