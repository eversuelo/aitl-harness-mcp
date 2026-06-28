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
import type { Document } from "mongodb";
import { ContextManager } from "../context/manager.js";
import { hydrate, summarizeSession } from "../memory/lifecycle.js";
import { makeEvent, makeMessage, makeRun } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";
import { routeSkills } from "../projectctx/router.js";
import { DefinitionStore } from "../projectctx/store.js";
import { type Provider, getProvider } from "../providers/base.js";
import { denyPathsGate, installDefaultGates } from "../hooks/gates.js";
import { type ToolRegistry, defaultRegistry } from "../tools/base.js";
import { withRetry } from "../util/retry.js";

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
  /** Install default safety gates (deny writes to .git/.env/keys) on the registry (default true). */
  gates?: boolean;
  /** Extra path/command deny patterns, added as a project-policy gate. */
  denyPaths?: string[];
  /** Engineering roles (H11) to attach: gate-mode roles veto in-loop; review/pair roles
   *  critique at the end-of-run checkpoint, producing a DecisionBrief for the engineer. */
  roles?: string[];
  /** Register the built-in Read/Write/Shell tools before running (default false). */
  installDefaultTools?: boolean;
  /** Max provider-call retries on transient errors, per turn (default 3). */
  retries?: number;
  /** Resume an existing run by id: reload its transcript and continue the loop. */
  resume?: string;
  /**
   * Termination gate. When the model stops, the run only ends if this returns `true`;
   * `false` (or a feedback string) is fed back as a new user turn and the loop continues
   * (bounded by `maxIters`). This turns `maxIters` from the only stop into a goal check.
   */
  verify?: (ctx: {
    finalText: string;
    convo: Record<string, unknown>[];
    project: string;
  }) => boolean | string | Promise<boolean | string>;
}

export interface RunAgentResult {
  run_id: string;
  final_text: string;
  iters: number;
  /** Slug of the session-summary memory doc written at the end, if any. */
  summary_slug?: string;
  /** Names of the project skills injected into the system prompt at start. */
  selected_skills?: string[];
  /** Number of tool calls blocked by a permission gate during the run. */
  gate_denials?: number;
  /** Final run status. */
  status?: "done" | "error";
  /** Role review checkpoint output (H11), if roles were attached. */
  decision_brief?: import("../roles/schema.js").DecisionBrief;
}

/** Rebuild a live convo from a run's persisted transcript (for resume). */
function rebuildConvo(msgs: Document[]): Record<string, unknown>[] {
  return msgs.map((m) => {
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
      return out;
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id ?? undefined, content: m.content ?? "" };
    }
    return { role: m.role, content: m.content ?? "" };
  });
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

  // ── enforcement setup: tools + deterministic permission gates, owned by the loop ──
  // Default safety gates are on unless explicitly disabled, so `runAgent` is safe even
  // when used as a library (not just via the CLI).
  if (opts.installDefaultTools) {
    const { ReadFileTool, WriteFileTool } = await import("../tools/filesystem.js");
    const { ShellTool } = await import("../tools/shell.js");
    for (const t of [new ReadFileTool(), new WriteFileTool(), new ShellTool()]) registry.register(t);
  }
  if (opts.gates !== false) {
    installDefaultGates(registry); // idempotent per registry
    if (opts.denyPaths?.length) registry.addGate(denyPathsGate(opts.denyPaths));
  }

  // ── engineering roles (H11): gate-mode roles veto in-loop; review/pair are
  //    applied at the end-of-run checkpoint (see below). They assist the engineer. ──
  let activeRoles: import("../roles/schema.js").Role[] = [];
  if (opts.roles?.length) {
    try {
      const { RoleStore } = await import("../roles/store.js");
      const { roleGate } = await import("../roles/engine.js");
      const rs = new RoleStore(store.db);
      for (const name of opts.roles) {
        const role = await rs.get(project, name);
        if (!role) continue;
        activeRoles.push(role);
        if (role.mode === "gate") registry.addGate(roleGate(role)); // blocking coupling
      }
    } catch {
      // roles are best-effort; never block the run.
    }
  }

  // ── resolve the run: fresh, or resumed from its durable transcript ──
  let runId: string;
  let convo: Record<string, unknown>[];
  let idx: number;
  let promptText: string; // the task text used to hydrate context
  if (typeof opts.resume === "string" && opts.resume) {
    runId = opts.resume;
    const doc = await store.db.collection("runs").findOne({ _id: runId as never });
    if (!doc) throw new Error(`runAgent: cannot resume unknown run '${runId}'`);
    project = (doc.project as string) ?? project;
    const msgs = await store.getMessages(runId);
    convo = rebuildConvo(msgs);
    idx = msgs.length ? Number(msgs[msgs.length - 1].idx ?? msgs.length) : 0;
    promptText = String(msgs.find((m) => m.role === "user")?.content ?? prompt);
    await store.db
      .collection("runs")
      .updateOne({ _id: runId as never }, { $set: { status: "running", ended_at: null } });
    await store.logEvent(makeEvent({ project, run_id: runId, type: "resume", payload: { from_idx: idx } }));
  } else {
    runId = randomUUID();
    const run = makeRun({ project, model: provider.name, harness_config: { max_iters: maxIters } });
    await store.db.collection("runs").insertOne({ ...run, _id: runId as never });
    convo = [{ role: "user", content: prompt }];
    idx = 0;
    promptText = prompt;
    await store.appendMessage(
      makeMessage({ project, run_id: runId, idx, role: "user", content: prompt }),
    );
  }

  // ── session start: build the system prompt from durable context ──
  // Order: recovered memory (mem_context) → relevant skills (skills_route) → base system.
  const preambles: string[] = [];
  let selectedSkills: string[] = [];
  if (opts.hydrate !== false) {
    try {
      const { preamble, sections } = await hydrate(project, promptText, { store });
      if (preamble) preambles.push(preamble);
      await store.logEvent(makeEvent({ project, run_id: runId, type: "hydrate", payload: { ...sections } }));
    } catch {
      // Hydration is best-effort; never block the run.
    }
  }
  if (opts.skills !== false) {
    try {
      const { preamble, selected } = await routeSkills(project, promptText, {
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

  let finalText = "";
  let gateDenials = 0;
  let it = 0;
  // Per-run rollups so the run record exposes the measurable totals (tokens, tool calls).
  let tokIn = 0;
  let tokOut = 0;
  let toolCalls = 0;
  try {
    for (; it < maxIters; it++) {
      if (ctx.overBudget(convo)) {
        convo = await ctx.compact(convo);
        await store.logEvent(makeEvent({ project, run_id: runId, type: "compaction", payload: { iter: it } }));
      }

      // Provider call is retried on transient failures (429/5xx/network) with backoff.
      const turn = await withRetry(
        () => provider.chat(convo, { tools: registry.schemas(), system }),
        {
          retries: opts.retries ?? 3,
          onRetry: ({ attempt, delayMs, error }) =>
            store.logEvent(
              makeEvent({
                project,
                run_id: runId,
                type: "retry",
                payload: { iter: it, attempt, delay_ms: delayMs, error: String(error).slice(0, 200) },
              }),
            ),
        },
      );
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
      tokIn += turn.usage.input ?? 0;
      tokOut += turn.usage.output ?? 0;
      toolCalls += turn.tool_calls.length;
      await store.logEvent(makeEvent({ project, run_id: runId, type: "loop_iter", payload: { iter: it } }));
      finalText = turn.text || finalText;

      if (turn.tool_calls.length === 0) {
        // Termination by verification: if a verifier is supplied, the run ends only when it
        // passes; a falsey/string result is fed back and the loop continues (bounded by maxIters).
        if (opts.verify) {
          const v = await opts.verify({ finalText, convo, project });
          const ok = v === true;
          await store.logEvent(
            makeEvent({
              project,
              run_id: runId,
              type: "verify",
              payload: { iter: it, ok, feedback: typeof v === "string" ? v.slice(0, 200) : null },
            }),
          );
          if (!ok) {
            const feedback =
              typeof v === "string" && v.trim()
                ? v
                : "Verification did not pass. Address the remaining issue, then finish.";
            convo.push({ role: "user", content: feedback });
            idx += 1;
            await store.appendMessage(
              makeMessage({ project, run_id: runId, idx, role: "user", content: feedback }),
            );
            continue;
          }
        }
        break; // model is done (and verification passed, if any)
      }

      convo.push({ role: "assistant", content: turn.text, tool_calls: turn.tool_calls });
      for (const call of turn.tool_calls) {
        let denyReason: string | null = null;
        const result = await registry.call(call.name, call.input ?? {}, (reason) => {
          denyReason = reason;
        });
        idx += 1;
        await store.appendMessage(
          makeMessage({
            project,
            run_id: runId,
            idx,
            role: "tool",
            content: result,
            tool_call_id: call.id ?? null,
          }),
        );
        // Audit: a denied call emits a `gate` event (it never ran); an allowed call a `tool_call`.
        if (denyReason !== null) {
          gateDenials += 1;
          await store.logEvent(
            makeEvent({
              project,
              run_id: runId,
              type: "gate",
              payload: { name: call.name, decision: "deny", reason: denyReason },
            }),
          );
        } else {
          await store.logEvent(
            makeEvent({ project, run_id: runId, type: "tool_call", payload: { name: call.name } }),
          );
        }
        convo.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  } catch (err) {
    // Unrecoverable failure: mark the run errored (so it never hangs in "running") and rethrow.
    const message = String(err instanceof Error ? err.message : err).slice(0, 500);
    await store.db
      .collection("runs")
      .updateOne({ _id: runId as never }, { $set: { status: "error", ended_at: new Date(), error: message } });
    await store.logEvent(makeEvent({ project, run_id: runId, type: "error", payload: { iter: it, message } }));
    throw err;
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

  // ── role checkpoint (H11): review/pair roles critique the final output, producing
  //    a DecisionBrief (advice + attributed objections) to assist the engineer. ──
  let decisionBrief: import("../roles/schema.js").DecisionBrief | undefined;
  const checkpointRoles = activeRoles.filter((r) => r.mode === "review" || r.mode === "pair");
  if (checkpointRoles.length) {
    try {
      const { deliberate } = await import("../roles/engine.js");
      decisionBrief = await deliberate({ project, target: finalText, roles: checkpointRoles, provider, store, runId });
    } catch {
      // role review is best-effort advice; never fail a completed run over it.
    }
  }

  await store.db
    .collection("runs")
    .updateOne(
      { _id: runId as never },
      {
        $set: {
          status: "done",
          ended_at: new Date(),
          token_usage: { input: tokIn, output: tokOut },
          iters: it,
          tool_calls: toolCalls,
          gate_denials: gateDenials,
          roles: activeRoles.map((r) => r.name),
          decision_blocked: decisionBrief?.blocked ?? false,
        },
      },
    );
  return {
    run_id: runId,
    final_text: finalText,
    iters: it + 1,
    summary_slug: summarySlug,
    selected_skills: selectedSkills,
    gate_denials: gateDenials,
    status: "done",
    decision_brief: decisionBrief,
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
