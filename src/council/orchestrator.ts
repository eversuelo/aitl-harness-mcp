/**
 * Plan-council orchestrator (ADR-0003 de la tesis, rebanada v1) — runCouncil.
 *
 * Rounds:
 *   R1 PROPOSE  — every proponent in parallel (Promise.allSettled); the surviving
 *                 proposals get anonymous labels A, B, C… in a stable random order.
 *   R2 CRITIQUE — every proponent receives the OTHERS' anonymized proposals (never its
 *                 own, never any authorship) and returns critiques + rubric scores + vote.
 *                 `--rounds` > 2 repeats the critique round; critiques accumulate.
 *   JUDGE       — a client DISTINCT from the proponents (enforced) receives proposals +
 *                 critiques and emits the CouncilVerdict.
 *
 * Discipline: malformed JSON gets ONE retry quoting the validation error; a second
 * failure is a NO-VOTE (event `council_no_vote`) — the council continues while ≥2
 * proposals survive, else it aborts with a clear error. Hard budget: at most
 * N proponents × R rounds base invocations (+1 retry per client/round); the judge call
 * (+1 retry) is not counted. Telemetry (run kind 'council' + events + a `design` memory
 * with the verdict) is best-effort: without a Mongo backend it warns and keeps going —
 * same degradation contract as `aitl init`/`synthesize`.
 */

import { randomUUID } from "node:crypto";
import { aggregateScores, type ProposalScore, RUBRIC_WEIGHTS } from "./rubric.js";
import {
  type CouncilCallCtx,
  type CouncilClientPort,
  type CouncilUsage,
  type CouncilVerdict,
  type LabeledProposal,
  type PlanCritique,
  type PlanProposal,
  CouncilFormatError,
} from "./ports.js";

// ── council composition ───────────────────────────────────────────────────────

/**
 * Split the listed clients into proponents + judge (v1 rule): with an explicit judge all
 * clients propose; without one and ≥3 clients the LAST listed client acts as judge only
 * (it does not propose); with exactly 2 clients a judge is mandatory → clear error.
 */
export function splitCouncil(
  clients: CouncilClientPort[],
  explicitJudge?: CouncilClientPort,
): { proponents: CouncilClientPort[]; judge: CouncilClientPort } {
  const ids = new Set<string>();
  for (const c of clients) {
    if (ids.has(c.id)) throw new Error(`council: cliente duplicado '${c.id}' — cada asiento debe ser distinto.`);
    ids.add(c.id);
  }
  if (explicitJudge) {
    if (ids.has(explicitJudge.id)) {
      throw new Error(`council: el juez ('${explicitJudge.id}') debe ser distinto de los proponentes.`);
    }
    if (clients.length < 2) throw new Error("council: se requieren ≥2 proponentes (usa --hosts a,b).");
    return { proponents: clients, judge: explicitJudge };
  }
  if (clients.length >= 3) {
    return { proponents: clients.slice(0, -1), judge: clients[clients.length - 1] };
  }
  throw new Error(
    "council: con exactamente 2 clientes hace falta un juez explícito — pasa --judge <host|provider[:modelo]> " +
      "(o lista ≥3 hosts; el último actúa solo de juez).",
  );
}

// ── anonymization ─────────────────────────────────────────────────────────────

export interface AuthoredProposal {
  clientId: string;
  proposal: PlanProposal;
}

export interface LabeledAuthoredProposal extends LabeledProposal {
  clientId: string;
}

/** Fisher–Yates on a copy (default label order source). */
export function defaultShuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Assign anonymous labels "A", "B", … in a stable random order (shuffled ONCE; the
 * mapping never changes afterwards). Injectable shuffle for deterministic tests.
 */
export function assignLabels(
  proposals: AuthoredProposal[],
  shuffle: <T>(items: T[]) => T[] = defaultShuffle,
): LabeledAuthoredProposal[] {
  return shuffle(proposals).map((p, i) => ({
    label: String.fromCharCode(65 + i), // A, B, C…
    clientId: p.clientId,
    proposal: p.proposal,
  }));
}

/** The proposals a critic may see: every one EXCEPT its own, stripped of authorship. */
export function proposalsForCritic(labeled: LabeledAuthoredProposal[], criticId: string): LabeledProposal[] {
  return labeled.filter((p) => p.clientId !== criticId).map((p) => ({ label: p.label, proposal: p.proposal }));
}

// ── telemetry seam (injectable; default = Mongo, tests use fakes) ─────────────

export interface CouncilTelemetryStore {
  createRun(args: { project: string; model: string; harness_config: Record<string, unknown> }): Promise<string>;
  updateRun(runId: string, patch: Record<string, unknown>): Promise<void>;
  logEvent(args: {
    project: string;
    run_id: string | null;
    type: "council_propose" | "council_critique" | "council_no_vote" | "council_verdict";
    payload: Record<string, unknown>;
  }): Promise<void>;
  /** Persist the verdict as a `design` memory linked to the run; returns the slug. */
  saveVerdictMemory(doc: {
    project: string;
    slug: string;
    description: string;
    body: string;
    tags: string[];
  }): Promise<string>;
}

/** Production telemetry: runs/events collections + MemoryStore (all via Mongoose). */
export function mongoCouncilTelemetry(): CouncilTelemetryStore {
  return {
    async createRun({ project, model, harness_config }) {
      const { ensureMongoose } = await import("../db/mongoose.js");
      const { RunModel, makeRun } = await import("../models/run.model.js");
      const runId = randomUUID();
      const run = await makeRun({ project, model, harness_config });
      await ensureMongoose();
      await RunModel.create({ ...run, _id: runId });
      return runId;
    },
    async updateRun(runId, patch) {
      const { ensureMongoose } = await import("../db/mongoose.js");
      const { RunModel } = await import("../models/run.model.js");
      await ensureMongoose();
      await RunModel.updateOne({ _id: runId }, { $set: patch });
    },
    async logEvent({ project, run_id, type, payload }) {
      const { MemoryStore } = await import("../memory/store.js");
      const { makeEvent } = await import("../models/event.model.js");
      await new MemoryStore().logEvent(await makeEvent({ project, run_id, type, payload }));
    },
    async saveVerdictMemory(doc) {
      const { MemoryStore } = await import("../memory/store.js");
      const { makeMemoryDoc } = await import("../models/memory.model.js");
      // `design` is a RESERVED_MEMORY_TYPES member: only harness pipelines (this one)
      // may write it — external writers get coerced to "project" (see mcpserver/api).
      const mem = await makeMemoryDoc({
        project: doc.project,
        slug: doc.slug,
        type: "design",
        category: "design",
        description: doc.description.slice(0, 160),
        body: doc.body,
        tags: doc.tags,
      });
      try {
        const { embedOne } = await import("../ingest/embedder.js");
        mem.embedding = await embedOne(`${mem.description}\n${mem.body}`);
      } catch {
        // embedding is optional; the doc is still text-searchable
      }
      return new MemoryStore().upsertMemory(mem);
    },
  };
}

// ── result shape ──────────────────────────────────────────────────────────────

export interface CouncilProposalEntry {
  label: string;
  client_id: string;
  proposal: PlanProposal;
}

export interface CouncilCritiqueEntry {
  critic_id: string;
  round: number;
  critique: PlanCritique;
}

export interface CouncilNoVote {
  client_id: string;
  phase: "propose" | "critique";
  round: number;
  error: string;
}

export interface CouncilResult {
  run_id: string | null;
  task: string;
  rounds: number;
  judge_id: string;
  proposals: CouncilProposalEntry[];
  critiques: CouncilCritiqueEntry[];
  no_votes: CouncilNoVote[];
  rubric: { weights: Record<string, number>; scores: Record<string, ProposalScore> };
  verdict: CouncilVerdict;
  /** Label → proposing client (de-anonymized AFTER deliberation, for the human/telemetry). */
  authors: Record<string, string>;
  token_usage: CouncilUsage;
  duration_ms: number;
  /** Slug of the persisted `design` memory, when telemetry could write it. */
  memory_slug: string | null;
}

export interface RunCouncilOpts {
  project: string;
  task: string;
  proponents: CouncilClientPort[];
  judge: CouncilClientPort;
  /** Total deliberation rounds: 1 propose + (rounds-1) critique. Default 2. */
  rounds?: number;
  /** Optional project context prepended to every prompt. */
  context?: string;
  /** Telemetry store; `null` = run without persisting (degraded mode). Default: Mongo. */
  telemetry?: CouncilTelemetryStore | null;
  /** Label-order source (injectable for deterministic tests). */
  shuffle?: <T>(items: T[]) => T[];
  /** Warning sink (default console.error). */
  warn?: (msg: string) => void;
}

// ── orchestration ─────────────────────────────────────────────────────────────

export async function runCouncil(opts: RunCouncilOpts): Promise<CouncilResult> {
  const rounds = opts.rounds ?? 2;
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`council: --rounds inválido (${opts.rounds}); usa un entero ≥ 1.`);
  }
  const { proponents, judge } = opts;
  if (proponents.length < 2) throw new Error("council: se requieren ≥2 proponentes.");
  if (proponents.some((p) => p.id === judge.id)) {
    throw new Error(`council: el juez ('${judge.id}') debe ser distinto de los proponentes.`);
  }
  const warn = opts.warn ?? ((msg: string) => console.error(msg));
  const t0 = Date.now();

  // Telemetry is best-effort throughout: the first failure disables it with ONE warning
  // (NO_BACKEND-style degradation) and the council keeps deliberating without persisting.
  let telemetry = opts.telemetry === undefined ? mongoCouncilTelemetry() : opts.telemetry;
  const tel = async <T>(fn: (t: CouncilTelemetryStore) => Promise<T>): Promise<T | null> => {
    if (!telemetry) return null;
    try {
      return await fn(telemetry);
    } catch (err) {
      telemetry = null;
      warn(
        `[aitl council] telemetría no disponible (${String(err instanceof Error ? err.message : err).slice(0, 160)}); ` +
          "el consejo continúa sin persistir.",
      );
      return null;
    }
  };

  const runId = await tel((t) =>
    t.createRun({
      project: opts.project,
      model: `council:${proponents.map((p) => p.id).join("+")}`,
      harness_config: {
        kind: "council",
        proponents: proponents.map((p) => ({ id: p.id, kind: p.kind })),
        judge: { id: judge.id, kind: judge.kind },
        rounds,
      },
    }),
  );

  // Hard budget: base invocations ≤ N proponents × R rounds (judge excluded); each base
  // invocation may add AT MOST one repair retry. The guard makes over-spending a loud bug.
  const budget = { spent: 0, max: proponents.length * rounds };
  const totalUsage: CouncilUsage = { input: 0, output: 0 };
  const noVotes: CouncilNoVote[] = [];

  interface CallOutcome<T> {
    value: T | null;
    duration_ms: number;
    tokens: CouncilUsage | null;
    error?: string;
  }

  /** One budgeted invocation: base call + 1 repair retry quoting the validation error. */
  const callWithRetry = async <T>(
    client: CouncilClientPort,
    phase: "propose" | "critique",
    round: number,
    invoke: (ctx: CouncilCallCtx) => Promise<T>,
  ): Promise<CallOutcome<T>> => {
    budget.spent += 1;
    if (budget.spent > budget.max) {
      throw new Error(`council: presupuesto de invocaciones excedido (${budget.spent} > ${budget.max}) — bug.`);
    }
    const started = Date.now();
    const baseCtx: CouncilCallCtx = opts.context ? { context: opts.context } : {};
    const take = (): CouncilUsage | null => {
      const u = client.lastUsage ?? null;
      if (u) {
        totalUsage.input += u.input;
        totalUsage.output += u.output;
      }
      return u;
    };
    try {
      const value = await invoke(baseCtx);
      return { value, duration_ms: Date.now() - started, tokens: take() };
    } catch (err) {
      take();
      const hint = err instanceof CouncilFormatError ? err.message : String(err instanceof Error ? err.message : err);
      try {
        const value = await invoke({ ...baseCtx, repairHint: hint.slice(0, 500) });
        return { value, duration_ms: Date.now() - started, tokens: take() };
      } catch (err2) {
        take();
        const msg = String(err2 instanceof Error ? err2.message : err2).slice(0, 300);
        noVotes.push({ client_id: client.id, phase, round, error: msg });
        await tel((t) =>
          t.logEvent({
            project: opts.project,
            run_id: runId,
            type: "council_no_vote",
            payload: { client: client.id, phase, round, error: msg, duration_ms: Date.now() - started },
          }),
        );
        return { value: null, duration_ms: Date.now() - started, tokens: null, error: msg };
      }
    }
  };

  const failRun = async (message: string): Promise<never> => {
    if (runId) {
      await tel((t) => t.updateRun(runId, { status: "error", ended_at: new Date(), error: message.slice(0, 500) }));
    }
    throw new Error(message);
  };

  // ── R1: PROPOSE (parallel) ───────────────────────────────────────────────────
  const proposeOutcomes = await Promise.all(
    proponents.map((p) => callWithRetry(p, "propose", 1, (ctx) => p.propose(opts.task, ctx))),
  );
  const authored: AuthoredProposal[] = [];
  proponents.forEach((p, i) => {
    const out = proposeOutcomes[i];
    if (out.value) authored.push({ clientId: p.id, proposal: out.value });
  });
  if (authored.length < 2) {
    await failRun(
      `council: quórum roto — solo ${authored.length} propuesta(s) válida(s) tras los reintentos; ` +
        "se requieren ≥2 para deliberar. Revisa los hosts (evento council_no_vote).",
    );
  }

  const labeled = assignLabels(authored, opts.shuffle);
  const labels = labeled.map((l) => l.label);
  const byClient = new Map(labeled.map((l) => [l.clientId, l] as const));
  // Emit the propose events AFTER labeling so each carries its anonymous label.
  for (const [i, p] of proponents.entries()) {
    const out = proposeOutcomes[i];
    if (!out.value) continue;
    const entry = byClient.get(p.id);
    await tel((t) =>
      t.logEvent({
        project: opts.project,
        run_id: runId,
        type: "council_propose",
        payload: {
          client: p.id,
          round: 1,
          label: entry?.label ?? null,
          steps: out.value?.steps.length ?? 0,
          estimated_complexity: out.value?.estimated_complexity ?? null,
          duration_ms: out.duration_ms,
          ...(out.tokens ? { tokens: out.tokens } : {}),
        },
      }),
    );
  }

  // ── R2..R: CRITIQUE (parallel per round; only clients WITH a live proposal critique) ──
  const critiques: CouncilCritiqueEntry[] = [];
  for (let round = 2; round <= rounds; round++) {
    const critics = proponents.filter((p) => byClient.has(p.id));
    const outcomes = await Promise.all(
      critics.map((p) => {
        const foreign = proposalsForCritic(labeled, p.id);
        const shown = new Set(foreign.map((f) => f.label));
        return callWithRetry(p, "critique", round, async (ctx) => {
          const items = await p.critique(foreign, opts.task, ctx);
          // Anonymity/validity check: every target and the vote must be labels this critic
          // was shown (its own label is NOT among them). Violations count as format errors.
          for (const c of items) {
            if (!shown.has(c.target)) throw new CouncilFormatError(`unknown critique target '${c.target}'`);
            if (!shown.has(c.vote)) throw new CouncilFormatError(`vote '${c.vote}' is not one of the shown labels`);
          }
          return items;
        });
      }),
    );
    for (const [i, p] of critics.entries()) {
      const out = outcomes[i];
      if (!out.value) continue;
      for (const critique of out.value) critiques.push({ critic_id: p.id, round, critique });
      await tel((t) =>
        t.logEvent({
          project: opts.project,
          run_id: runId,
          type: "council_critique",
          payload: {
            client: p.id,
            round,
            targets: out.value?.map((c) => c.target) ?? [],
            vote: out.value?.[0]?.vote ?? null,
            duration_ms: out.duration_ms,
            ...(out.tokens ? { tokens: out.tokens } : {}),
          },
        }),
      );
    }
  }

  // ── JUDGE (never counted against the round budget; 1 retry, else the council fails) ──
  const anonForJudge: LabeledProposal[] = labeled.map((l) => ({ label: l.label, proposal: l.proposal }));
  const flatCritiques = critiques.map((c) => c.critique);
  const judgeCtx: CouncilCallCtx = opts.context ? { context: opts.context } : {};
  const judgeOnce = async (ctx: CouncilCallCtx): Promise<CouncilVerdict> => {
    const v = await judge.judge(anonForJudge, flatCritiques, opts.task, ctx);
    if (v.winner !== null && !labels.includes(v.winner)) {
      throw new CouncilFormatError(`winner '${v.winner}' is not one of the labels (${labels.join(", ")})`);
    }
    return v;
  };
  const judgeStarted = Date.now();
  let verdict: CouncilVerdict;
  try {
    verdict = await judgeOnce(judgeCtx);
  } catch (err) {
    const hint = err instanceof CouncilFormatError ? err.message : String(err instanceof Error ? err.message : err);
    try {
      verdict = await judgeOnce({ ...judgeCtx, repairHint: hint.slice(0, 500) });
    } catch (err2) {
      return failRun(
        `council: el juez '${judge.id}' no produjo un veredicto válido tras un reintento ` +
          `(${String(err2 instanceof Error ? err2.message : err2).slice(0, 300)}).`,
      );
    }
  }
  const judgeUsage = judge.lastUsage ?? null;
  if (judgeUsage) {
    totalUsage.input += judgeUsage.input;
    totalUsage.output += judgeUsage.output;
  }

  const rubricScores = aggregateScores(flatCritiques);
  const authors = Object.fromEntries(labeled.map((l) => [l.label, l.clientId]));
  const durationMs = Date.now() - t0;

  await tel((t) =>
    t.logEvent({
      project: opts.project,
      run_id: runId,
      type: "council_verdict",
      payload: {
        judge: judge.id,
        winner: verdict.winner,
        winner_client: verdict.winner ? (authors[verdict.winner] ?? null) : null,
        per_proposal_scores: verdict.per_proposal_scores,
        duration_ms: Date.now() - judgeStarted,
        ...(judgeUsage ? { tokens: judgeUsage } : {}),
      },
    }),
  );

  // Persist the verdict as a `design` memory linked to the run — best-effort, like the run.
  let memorySlug: string | null = null;
  if (runId) {
    const id8 = runId.slice(0, 8);
    memorySlug = await tel((t) =>
      t.saveVerdictMemory({
        project: opts.project,
        slug: `council-verdict-${id8}`,
        description: `Council verdict: ${verdict.winner ? `winner ${verdict.winner} (${authors[verdict.winner]})` : "no winner"} — ${opts.task}`,
        body: verdictMemoryBody(opts.task, labeled, rubricScores, verdict, authors, runId),
        tags: ["council", `run:${id8}`],
      }),
    );
    await tel((t) =>
      t.updateRun(runId, {
        status: "done",
        ended_at: new Date(),
        token_usage: totalUsage,
        council: {
          winner: verdict.winner,
          winner_client: verdict.winner ? (authors[verdict.winner] ?? null) : null,
          proposals: labeled.length,
          no_votes: noVotes.length,
          memory_slug: memorySlug,
        },
      }),
    );
  }

  return {
    run_id: runId,
    task: opts.task,
    rounds,
    judge_id: judge.id,
    proposals: labeled.map((l) => ({ label: l.label, client_id: l.clientId, proposal: l.proposal })),
    critiques,
    no_votes: noVotes,
    rubric: { weights: { ...RUBRIC_WEIGHTS }, scores: rubricScores },
    verdict,
    authors,
    token_usage: totalUsage,
    duration_ms: durationMs,
    memory_slug: memorySlug,
  };
}

/** Markdown body of the durable `design` memory that records the verdict. */
function verdictMemoryBody(
  task: string,
  labeled: LabeledAuthoredProposal[],
  scores: Record<string, ProposalScore>,
  verdict: CouncilVerdict,
  authors: Record<string, string>,
  runId: string,
): string {
  const lines: string[] = [
    `# Council verdict — run ${runId}`,
    "",
    `## Tarea`,
    task,
    "",
    `## Veredicto`,
    `- Ganador: ${verdict.winner ? `${verdict.winner} (${authors[verdict.winner]})` : "ninguno"}`,
    `- Síntesis: ${verdict.synthesis}`,
    `- Razonamiento: ${verdict.reasoning}`,
    "",
    "## Propuestas",
  ];
  for (const l of labeled) {
    const s = scores[l.label];
    lines.push(
      `### ${l.label} — ${l.clientId} (complejidad ${l.proposal.estimated_complexity}` +
        `${s ? `, rúbrica ${s.total.toFixed(2)}/5` : ""})`,
    );
    for (const step of l.proposal.steps) lines.push(`1. ${step.title}`);
    lines.push("");
  }
  lines.push("```json", JSON.stringify({ verdict, per_proposal_rubric: scores }, null, 2), "```");
  return lines.join("\n");
}
