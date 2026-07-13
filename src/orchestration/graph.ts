/**
 * The agent loop: prompt -> model -> tools -> repeat.
 *
 * `runAgent` is a fully-working, provider-agnostic loop that persists the run and
 * every turn into MongoDB (durable transcript) and respects the context budget.
 * Runs are resumable/replayable from that durable transcript (`opts.resume`) — no
 * graph framework involved.
 */

import { randomUUID } from "node:crypto";
import type { Document } from "mongodb";
import { ContextManager } from "../context/manager.js";
import { ensureMongoose } from "../db/mongoose.js";
import { hydrate, summarizeSession } from "../memory/lifecycle.js";
import { makeEvent } from "../models/event.model.js";
import { makeMessage } from "../models/message.model.js";
import { RunModel, makeRun } from "../models/run.model.js";
import { MemoryStore } from "../memory/store.js";
import { routeSkills } from "../projectctx/router.js";
import { DefinitionStore } from "../projectctx/store.js";
import { type Provider, type StreamDelta, getProvider } from "../providers/base.js";
import { denyPathsGate, installDefaultGates } from "../hooks/gates.js";
import { type ToolRegistry, defaultRegistry } from "../tools/base.js";
import { withRetry } from "../util/retry.js";
import {
  type LoopSpec,
  LoopSpecSchema,
  budgetBreached,
  loadLoopSpecAuto,
  loopSpecVersion,
  resolveLoopPolicy,
} from "./loopspec.js";
import { STALL_FEEDBACK, StallTracker, progressSignature, workspaceDigest } from "./stall.js";
import { consumeStream, StreamInterrupted } from "./stream.js";

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
  /** Human-in-the-loop (ADR-0040): confirm side-effect tools (requiresApproval) before they run. */
  ask?: boolean;
  /** Non-interactive fallback for `ask` when stdin is not a TTY: "deny" (default) | "allow". */
  askPolicy?: "deny" | "allow";
  /**
   * Streaming observer (ADR-0005): receives assistant text deltas as they arrive.
   * Only used when the provider implements `chatStream`; otherwise the loop calls
   * `chat()` and behaviour is byte-for-byte identical to a non-streaming run.
   */
  onDelta?: (delta: StreamDelta) => void;
  /**
   * Tool observer (chat UI): fires when a tool call starts, finishes, or is denied
   * by a gate. Purely observational — persistence/audit events are unchanged.
   */
  onTool?: (ev: {
    name: string;
    args?: Record<string, unknown>;
    phase: "start" | "done" | "denied";
    reason?: string;
    ms?: number;
  }) => void;
  /** Resume an existing run by id: reload its transcript and continue the loop.
   *  A non-empty `prompt` is appended as a NEW user turn (multi-turn chat, ADR-0003);
   *  pass "" to just continue an interrupted run from where it stopped. */
  resume?: string;
  /**
   * Termination gate. When the model stops, the run only ends if this returns `true`;
   * `false` (or a feedback string) is fed back as a new user turn and the loop continues
   * (bounded by `maxIters`). This turns `maxIters` from the only stop into a goal check.
   */
  verify?: (ctx: VerifyCtx) => boolean | string | Promise<boolean | string>;
  /** Composable quality gates: ALL must pass for the run to end; failures are aggregated
   *  into one feedback turn and each verdict is logged as its own `verify` event. */
  verifiers?: Verifier[];
  /** Verify-failure feedback rounds granted before ending `verify_exhausted` (default 3).
   *  Each granted round refreshes the `maxIters` work window, so verification retries
   *  never compete with work iterations. */
  maxVerifyRounds?: number;
  /** Hard budgets checked each iteration. On breach the model gets ONE final no-tools
   *  wrap-up turn ("summarize state and stop") instead of a hard cut. */
  budgets?: { tokens?: number; ms?: number };
  /** Consecutive no-progress iterations (same tool calls + unchanged workspace) that trip
   *  the stall detector: first strike injects corrective feedback, second ends the run
   *  `stalled`. 0 disables (default 3). */
  stallThreshold?: number;
  /** After a failed verification, force one no-tools diagnosis turn before acting again. */
  reflect?: boolean;
  /** Loop policy as a versioned spec: a name in the `loops` collection, a JSON file path,
   *  or an inline spec. Explicit opts above override spec fields; the resolved
   *  `loop_spec@version` is stamped into the run's `harness_config` (traceability). */
  loopSpec?: string | LoopSpec;
  /** Caller abort (ESC in the chat REPL): stops the loop cleanly at the next checkpoint —
   *  mid-stream, between tool calls, or at the iteration top. The run ends `interrupted`
   *  with a coherent transcript, so `resume` can continue it. */
  signal?: AbortSignal;
}

export interface VerifyCtx {
  finalText: string;
  convo: Record<string, unknown>[];
  project: string;
}

/** A named quality gate over the run's outcome (tests, lint, custom checks…). */
export interface Verifier {
  name: string;
  run: (ctx: VerifyCtx) => boolean | string | Promise<boolean | string>;
}

/** Why the loop ended — `done`/`error` alone cannot distinguish these outcomes. */
export type RunStopReason =
  | "completed" // model stopped and verification (if any) passed
  | "max_iters" // iteration window exhausted; final verification did not pass
  | "verify_exhausted" // all verify rounds spent without passing
  | "stalled" // no progress across iterations, twice
  | "budget" // token/wall-clock budget breached (after the wrap-up turn)
  | "interrupted"; // caller abort (ESC in the chat REPL); the run stays resumable

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
  /** Token rollup for the whole run (also persisted on the run doc). */
  token_usage?: { input: number; output: number };
  /** Total tool calls executed during the run. */
  tool_calls?: number;
  /** Final run status. */
  status?: "done" | "error";
  /** Why the loop ended (also persisted on the run doc as `stop_reason`). */
  stop_reason?: RunStopReason;
  /** Verification outcome: true/false when verifiers ran, null when none configured. */
  verified?: boolean | null;
  /** Verify-failure feedback rounds consumed. */
  verify_rounds?: number;
  /** Stall strikes hit (0 = never stalled). */
  stall_strikes?: number;
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

  // ── loop policy: explicit opts > versioned LoopSpec > built-in defaults (ADR-0062) ──
  let spec: LoopSpec | null = null;
  let specRef = null;
  if (opts.loopSpec) {
    if (typeof opts.loopSpec === "string") {
      ({ spec, ref: specRef } = await loadLoopSpecAuto(project, opts.loopSpec));
    } else {
      spec = LoopSpecSchema.parse(opts.loopSpec);
      specRef = { name: spec.name, version: loopSpecVersion(spec), source: "inline" as const };
    }
  }
  const policy = resolveLoopPolicy(
    {
      maxIters: opts.maxIters,
      budgets: opts.budgets,
      stallThreshold: opts.stallThreshold,
      maxVerifyRounds: opts.maxVerifyRounds,
      reflect: opts.reflect,
    },
    spec,
    specRef,
  );
  const maxIters = policy.maxIters;
  const ctx = new ContextManager(undefined, provider);

  // Composable verification: `verifiers` plus the legacy single `verify` callback.
  const verifiers: Verifier[] = [...(opts.verifiers ?? [])];
  if (opts.verify) verifiers.push({ name: "verify", run: opts.verify });
  // A spec's verifyCmd makes file/store specs self-contained quality gates.
  if (spec?.verifyCmd) {
    const cmd = spec.verifyCmd;
    verifiers.push({
      name: "verify_cmd",
      run: async () => {
        const { execSync } = await import("node:child_process");
        try {
          execSync(cmd, { stdio: "pipe", encoding: "utf8" });
          return true;
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message?: string };
          return `Quality gate failed (\`${cmd}\`). Fix it, then finish:\n${
            (err.stdout ?? "") + (err.stderr ?? "") || err.message || "non-zero exit"
          }`.slice(0, 2000);
        }
      },
    });
  }

  // ── enforcement setup: tools + deterministic permission gates, owned by the loop ──
  // Default safety gates are on unless explicitly disabled, so `runAgent` is safe even
  // when used as a library (not just via the CLI).
  if (opts.installDefaultTools) {
    const { EditFileTool, ReadFileTool, WriteFileTool } = await import("../tools/filesystem.js");
    const { ShellTool } = await import("../tools/shell.js");
    for (const t of [new ReadFileTool(), new EditFileTool(), new WriteFileTool(), new ShellTool()])
      registry.register(t);
  }
  if (opts.gates !== false) {
    installDefaultGates(registry); // idempotent per registry
    if (opts.denyPaths?.length) registry.addGate(denyPathsGate(opts.denyPaths));
  }

  // ── ADR regression guard (Layer 3, TODO.md §3): annotate write/edit results ──
  // with reminders of active ADRs whose components[] match the edited file's dir.
  // Best-effort: degrades silently if Mongo is unavailable.
  try {
    const { installAdrGuard } = await import("../hooks/adrGuard.js");
    installAdrGuard(registry, { project });
  } catch {
    // adrGuard import or install failed — never block the loop.
  }

  // ── engineering roles (H11): gate-mode roles veto in-loop; review/pair are
  //    applied at the end-of-run checkpoint (see below). They assist the engineer. ──
  let activeRoles: import("../roles/schema.js").Role[] = [];
  if (opts.roles?.length) {
    try {
      const { RoleStore } = await import("../roles/store.js");
      const { roleGate } = await import("../roles/engine.js");
      const rs = new RoleStore();
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
    await ensureMongoose();
    const doc = await RunModel.findOne({ _id: runId }).lean();
    if (!doc) throw new Error(`runAgent: cannot resume unknown run '${runId}'`);
    project = (doc.project as string) ?? project;
    const msgs = await store.getMessages(runId);
    convo = rebuildConvo(msgs);
    idx = msgs.length ? Number(msgs[msgs.length - 1].idx ?? msgs.length) : 0;
    promptText = String(msgs.find((m) => m.role === "user")?.content ?? prompt);
    // Multi-turn (aitl chat): a non-empty prompt on resume is a NEW user turn appended
    // to the recovered transcript; plain interrupted-run resumes pass "".
    if (prompt) {
      convo.push({ role: "user", content: prompt });
      idx += 1;
      await store.appendMessage(
        await makeMessage({ project, run_id: runId, idx, role: "user", content: prompt }),
      );
      promptText = prompt;
    }
    await RunModel.updateOne({ _id: runId }, { $set: { status: "running", ended_at: null } });
    await store.logEvent(await makeEvent({ project, run_id: runId, type: "resume", payload: { from_idx: idx } }));
  } else {
    runId = randomUUID();
    // The FULL resolved loop policy is stamped on the run: any measurement can state
    // exactly which loop design produced it (loop engineering as a versioned spec).
    const run = await makeRun({
      project,
      model: provider.name,
      harness_config: {
        max_iters: maxIters,
        stall_threshold: policy.stallThreshold,
        max_verify_rounds: policy.maxVerifyRounds,
        reflect: policy.reflect,
        ...(policy.budgets ? { budgets: policy.budgets } : {}),
        ...(policy.specRef ? { loop_spec: policy.specRef } : {}),
      },
    });
    await ensureMongoose();
    await RunModel.create({ ...run, _id: runId });
    convo = [{ role: "user", content: prompt }];
    idx = 0;
    promptText = prompt;
    await store.appendMessage(
      await makeMessage({ project, run_id: runId, idx, role: "user", content: prompt }),
    );
  }

  // ── human-in-the-loop (--ask): approval gate for side-effect tools (ADR-0040) ──
  // Registered after the deterministic gates so a human is never asked about a call
  // that policy would deny anyway. Idempotent per registry (multi-turn safe).
  if (opts.ask) {
    const { installApprovalGate } = await import("../hooks/approval.js");
    installApprovalGate(registry, {
      policy: opts.askPolicy,
      onDecision: async (ev) => {
        // The human's wait time (ms) feeds the supervision metric (H11) in run-show.
        void store.logEvent(
          await makeEvent({
            project,
            run_id: runId,
            type: "approval",
            payload: { tool: ev.tool, decision: ev.decision, ms: ev.ms, interactive: ev.interactive },
          }),
        );
      },
    });
  }

  // ── session start: build the system prompt from durable context ──
  // Order: recovered memory (mem_context) → relevant skills (skills_route) → base system.
  const preambles: string[] = [];
  let selectedSkills: string[] = [];
  if (opts.hydrate !== false) {
    try {
      const { preamble, sections } = await hydrate(project, promptText, { store });
      if (preamble) preambles.push(preamble);
      await store.logEvent(await makeEvent({ project, run_id: runId, type: "hydrate", payload: { ...sections } }));
    } catch {
      // Hydration is best-effort; never block the run.
    }
  }
  if (opts.skills !== false) {
    try {
      const { preamble, selected } = await routeSkills(project, promptText, {
        store: new DefinitionStore("skill"),
      });
      selectedSkills = selected;
      if (preamble) preambles.push(preamble);
      await store.logEvent(await makeEvent({ project, run_id: runId, type: "skills_route", payload: { selected } }));
    } catch {
      // Skill routing is best-effort; never block the run.
    }
    // Agents: the SAME routing cascade over the `agents` collection, so the loop always
    // consults the project's agent briefs too (ADR-0063). Role records (metadata.kind
    // "role") are excluded — they enter via `opts.roles`, not the preamble.
    try {
      const { preamble, selected } = await routeSkills(project, promptText, {
        store: new DefinitionStore("agent"),
        heading: "## Project agents (operating briefs relevant to this task)",
        instruction: "Follow these agent briefs when acting in their domain.",
        filter: (rec) =>
          (rec as { metadata?: { kind?: string } }).metadata?.kind !== "role",
      });
      if (preamble) preambles.push(preamble);
      await store.logEvent(
        await makeEvent({ project, run_id: runId, type: "skills_route", payload: { selected, kind: "agent" } }),
      );
    } catch {
      // Agent routing is best-effort; never block the run.
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
  // ── loop-engineering state (ADR-0062): work window, verify rounds, stall, budgets ──
  const t0 = Date.now();
  const stall = new StallTracker(policy.stallThreshold);
  let itersLeft = maxIters;
  let verifyRounds = 0;
  let stallStrikes = 0;
  let stopReason: RunStopReason = "completed";
  // null = no verifiers configured (outcome unknowable); set on every verifier pass.
  let verified: boolean | null = verifiers.length ? false : null;

  const appendUser = async (content: string) => {
    convo.push({ role: "user", content });
    idx += 1;
    await store.appendMessage(
      await makeMessage({ project, run_id: runId, idx, role: "user", content }),
    );
  };

  // Run ALL verifiers; each verdict is its own `verify` event; failures are aggregated.
  const runVerifiers = async (iter: number): Promise<{ ok: boolean; feedback: string }> => {
    const failures: string[] = [];
    for (const v of verifiers) {
      let res: boolean | string;
      try {
        res = await v.run({ finalText, convo, project });
      } catch (err) {
        res = `verifier crashed: ${err instanceof Error ? err.message : String(err)}`;
      }
      const ok = res === true;
      await store.logEvent(
        await makeEvent({
          project,
          run_id: runId,
          type: "verify",
          payload: {
            iter,
            verifier: v.name,
            ok,
            feedback: typeof res === "string" ? res.slice(0, 200) : null,
          },
        }),
      );
      if (!ok) {
        failures.push(
          typeof res === "string" && res.trim()
            ? `[${v.name}] ${res}`
            : `[${v.name}] Verification did not pass.`,
        );
      }
    }
    return { ok: failures.length === 0, feedback: failures.join("\n") };
  };

  // Reflection (#6): one no-tools diagnosis turn between a failed verification and the
  // next action, so the model commits to WHAT it will change before touching anything.
  const reflect = async (feedback: string) => {
    await appendUser(
      `${feedback}\n\nBefore touching anything again: diagnose in a few lines WHY ` +
        "verification failed and what you will change. Do not use tools in this reply.",
    );
    const turn = await withRetry(() => provider.chat(convo, { system }), {
      retries: opts.retries ?? 3,
    });
    convo.push({ role: "assistant", content: turn.text });
    idx += 1;
    await store.appendMessage(
      await makeMessage({
        project,
        run_id: runId,
        idx,
        role: "assistant",
        content: turn.text,
        tokens: turn.usage.output,
      }),
    );
    tokIn += turn.usage.input ?? 0;
    tokOut += turn.usage.output ?? 0;
    await store.logEvent(
      await makeEvent({ project, run_id: runId, type: "reflection", payload: { iter: it } }),
    );
  };

  // Caller abort: audit trail for every interrupt checkpoint that fires.
  const noteInterrupt = async () =>
    store.logEvent(await makeEvent({ project, run_id: runId, type: "interrupt", payload: { iter: it } }));

  try {
    for (; ; it++) {
      // Interrupt checkpoint (iteration top): the transcript is coherent here, so the
      // run ends `interrupted` and stays resumable.
      if (opts.signal?.aborted) {
        stopReason = "interrupted";
        await noteInterrupt();
        break;
      }

      // Budget gate (#3): on breach, ONE final no-tools wrap-up turn instead of a hard cut.
      const breach = budgetBreached(policy.budgets, {
        tokens: tokIn + tokOut,
        ms: Date.now() - t0,
      });
      if (breach) {
        await store.logEvent(
          await makeEvent({
            project,
            run_id: runId,
            type: "budget",
            payload: { iter: it, breach, tokens: tokIn + tokOut, ms: Date.now() - t0 },
          }),
        );
        await appendUser(
          `The run's ${breach} budget is exhausted. Do not use tools. Summarize what was ` +
            "accomplished, what remains, and the exact state you are leaving things in, then stop.",
        );
        const wrap = await withRetry(() => provider.chat(convo, { system }), {
          retries: opts.retries ?? 3,
        });
        idx += 1;
        await store.appendMessage(
          await makeMessage({
            project,
            run_id: runId,
            idx,
            role: "assistant",
            content: wrap.text,
            tokens: wrap.usage.output,
          }),
        );
        tokIn += wrap.usage.input ?? 0;
        tokOut += wrap.usage.output ?? 0;
        finalText = wrap.text || finalText;
        stopReason = "budget";
        break;
      }

      // Exhausted work window (#1): the run STILL gets verified — an exhausted run must
      // never look identical to a verified success.
      if (itersLeft <= 0) {
        if (verifiers.length) {
          const { ok } = await runVerifiers(it);
          verified = ok;
          stopReason = ok ? "completed" : "max_iters";
        } else {
          stopReason = "max_iters";
        }
        break;
      }
      itersLeft -= 1;

      if (ctx.overBudget(convo)) {
        convo = await ctx.compact(convo);
        await store.logEvent(await makeEvent({ project, run_id: runId, type: "compaction", payload: { iter: it } }));
      }

      // Provider call is retried on transient failures (429/5xx/network) with backoff.
      // With an observer + a streaming provider the turn streams (ADR-0005); the
      // resolved ChatTurn is identical either way. A retry mid-stream replays the
      // whole turn, so deltas may repeat on flaky networks (persistence never does).
      const onDelta = opts.onDelta;
      const doTurn = () =>
        onDelta && provider.chatStream
          ? consumeStream(provider.chatStream(convo, { tools: registry.schemas(), system }), onDelta, {
              signal: opts.signal,
            })
          : provider.chat(convo, { tools: registry.schemas(), system });
      let turn: Awaited<ReturnType<typeof doTurn>>;
      try {
        turn = await withRetry(
          doTurn,
          {
            retries: opts.retries ?? 3,
            onRetry: async ({ attempt, delayMs, error }) =>
              store.logEvent(
                await makeEvent({
                  project,
                  run_id: runId,
                  type: "retry",
                  payload: { iter: it, attempt, delay_ms: delayMs, error: String(error).slice(0, 200) },
                }),
              ),
          },
        );
      } catch (err) {
        // Interrupt checkpoint (mid-stream): the in-flight turn is discarded — nothing
        // of it was persisted — so the transcript stays coherent and resumable.
        if (err instanceof StreamInterrupted) {
          stopReason = "interrupted";
          await noteInterrupt();
          break;
        }
        throw err;
      }
      idx += 1;
      await store.appendMessage(
        await makeMessage({
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
      await store.logEvent(await makeEvent({ project, run_id: runId, type: "loop_iter", payload: { iter: it } }));
      finalText = turn.text || finalText;

      if (turn.tool_calls.length === 0) {
        // Termination by verification (#4): ALL verifiers must pass for the run to end.
        // A failure grants a FRESH work window (bounded by maxVerifyRounds), so verify
        // retries never compete with work iterations.
        if (verifiers.length) {
          const { ok, feedback } = await runVerifiers(it);
          if (!ok) {
            verifyRounds += 1;
            if (verifyRounds > policy.maxVerifyRounds) {
              verified = false;
              stopReason = "verify_exhausted";
              break;
            }
            itersLeft = maxIters;
            const msg =
              feedback.trim() ||
              "Verification did not pass. Address the remaining issue, then finish.";
            if (policy.reflect) await reflect(msg);
            else await appendUser(msg);
            continue;
          }
          verified = true;
        }
        stopReason = "completed";
        break; // model is done (and verification passed, if any)
      }

      convo.push({ role: "assistant", content: turn.text, tool_calls: turn.tool_calls });
      let interruptedInTools = false;
      for (const call of turn.tool_calls) {
        // Interrupt checkpoint (between tool calls): pending calls never execute, but
        // each still gets a synthetic result — a dangling tool_call would corrupt the
        // transcript for `resume` and the next provider round-trip.
        if (opts.signal?.aborted) {
          interruptedInTools = true;
          idx += 1;
          await store.appendMessage(
            await makeMessage({
              project,
              run_id: runId,
              idx,
              role: "tool",
              content: "[interrupted by user — tool not executed]",
              tool_call_id: call.id ?? null,
            }),
          );
          convo.push({ role: "tool", tool_call_id: call.id, content: "[interrupted by user — tool not executed]" });
          continue;
        }
        let denyReason: string | null = null;
        opts.onTool?.({ name: call.name, args: call.input ?? {}, phase: "start" });
        const toolT0 = Date.now();
        const result = await registry.call(
          call.name,
          call.input ?? {},
          (reason) => {
            denyReason = reason;
          },
          {
            // A hook that acts (mutates args/result) leaves a durable trace, so hook
            // interference is observable in the same event stream as gates/tool calls.
            onHookEvent: async (ev) => {
              void store.logEvent(
                await makeEvent({
                  project,
                  run_id: runId,
                  type: ev.phase === "pre" ? "tool_pre_hook" : "tool_post_hook",
                  payload: { name: ev.tool, index: ev.index },
                }),
              );
            },
          },
        );
        idx += 1;
        await store.appendMessage(
          await makeMessage({
            project,
            run_id: runId,
            idx,
            role: "tool",
            content: result,
            tool_call_id: call.id ?? null,
          }),
        );
        opts.onTool?.(
          denyReason !== null
            ? { name: call.name, phase: "denied", reason: denyReason }
            : { name: call.name, phase: "done", ms: Date.now() - toolT0 },
        );
        // Audit: a denied call emits a `gate` event (it never ran); an allowed call a `tool_call`.
        if (denyReason !== null) {
          gateDenials += 1;
          await store.logEvent(
            await makeEvent({
              project,
              run_id: runId,
              type: "gate",
              payload: { name: call.name, decision: "deny", reason: denyReason },
            }),
          );
        } else {
          await store.logEvent(
            await makeEvent({ project, run_id: runId, type: "tool_call", payload: { name: call.name } }),
          );
        }
        convo.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (interruptedInTools) {
        stopReason = "interrupted";
        await noteInterrupt();
        break;
      }

      // Stall detection (#2): same tool calls + unchanged workspace across consecutive
      // iterations means the loop is spinning, not progressing. First strike injects
      // corrective feedback; a second strike ends the run as `stalled` — a distinct,
      // measurable outcome that must never masquerade as success.
      if (policy.stallThreshold > 0) {
        const verdict = stall.observe(
          progressSignature(turn.tool_calls, await workspaceDigest()),
        );
        if (verdict.stalled) {
          stallStrikes += 1;
          await store.logEvent(
            await makeEvent({
              project,
              run_id: runId,
              type: "stall",
              payload: { iter: it, action: verdict.action, strikes: stallStrikes },
            }),
          );
          if (verdict.action === "abort") {
            stopReason = "stalled";
            break;
          }
          await appendUser(STALL_FEEDBACK);
        }
      }
    }
  } catch (err) {
    // Unrecoverable failure: mark the run errored (so it never hangs in "running") and rethrow.
    const message = String(err instanceof Error ? err.message : err).slice(0, 500);
    await ensureMongoose();
    await RunModel.updateOne({ _id: runId }, { $set: { status: "error", ended_at: new Date(), error: message } });
    await store.logEvent(await makeEvent({ project, run_id: runId, type: "error", payload: { iter: it, message } }));
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
          await makeEvent({ project, run_id: runId, type: "session_summary", payload: { slug: res.slug, category: res.category } }),
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

  await ensureMongoose();
  await RunModel.updateOne(
    { _id: runId },
    {
      $set: {
        status: "done",
        ended_at: new Date(),
        token_usage: { input: tokIn, output: tokOut },
        iters: it,
        tool_calls: toolCalls,
        gate_denials: gateDenials,
        stop_reason: stopReason,
        verified,
        verify_rounds: verifyRounds,
        stall_strikes: stallStrikes,
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
    token_usage: { input: tokIn, output: tokOut },
    tool_calls: toolCalls,
    status: "done",
    stop_reason: stopReason,
    verified,
    verify_rounds: verifyRounds,
    stall_strikes: stallStrikes,
    decision_brief: decisionBrief,
  };
}
