/**
 * Plan-council ports (ADR-0003 de la tesis, rebanada v1) — types + Zod schemas.
 *
 * The council deliberates over a PLAN before anyone executes it: several clients
 * (hosts and/or raw-model providers) PROPOSE a plan, CRITIQUE each other's proposals
 * anonymously (labels "A"/"B"/… — a client never sees its own proposal nor any
 * authorship), and a distinct JUDGE synthesizes a verdict. Everything a client says
 * MUST be a strict JSON object validated against these schemas; malformed output gets
 * one repair retry and then costs the client its vote for that round (see orchestrator).
 */

import { z } from "zod";

// ── proposal ──────────────────────────────────────────────────────────────────

export const PlanStepSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().default(""),
});

export const PlanProposalSchema = z.object({
  steps: z.array(PlanStepSchema).min(1),
  risks: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  estimated_complexity: z.enum(["low", "medium", "high"]),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

// ── critique ──────────────────────────────────────────────────────────────────

export const CritiqueFindingSchema = z.object({
  severity: z.enum(["info", "minor", "major"]),
  comment: z.string(),
});

/** One critique of ONE anonymous proposal (`target` is the "A"/"B"/… label). */
export const PlanCritiqueSchema = z.object({
  target: z.string().min(1),
  findings: z.array(CritiqueFindingSchema).default([]),
  /** Score 0–5 per rubric criterion (see rubric.ts); unknown keys are ignored on aggregation. */
  scores: z.record(z.number().min(0).max(5)),
  /** Label of the proposal this critic prefers overall (its vote, repeated per critique). */
  vote: z.string().min(1),
});

export type CritiqueFinding = z.infer<typeof CritiqueFindingSchema>;
export type PlanCritique = z.infer<typeof PlanCritiqueSchema>;

/**
 * Wire shape a client actually replies with in the critique round: one object with
 * per-target critiques + a single vote (the orchestrator fans it out into PlanCritique[]).
 */
export const CritiqueReplySchema = z.object({
  critiques: z
    .array(
      z.object({
        target: z.string().min(1),
        findings: z.array(CritiqueFindingSchema).default([]),
        scores: z.record(z.number().min(0).max(5)),
      }),
    )
    .min(1),
  vote: z.string().min(1),
});

export type CritiqueReply = z.infer<typeof CritiqueReplySchema>;

// ── verdict ───────────────────────────────────────────────────────────────────

export const CouncilVerdictSchema = z.object({
  winner: z.string().min(1).nullable(),
  synthesis: z.string(),
  reasoning: z.string(),
  /** Judge's own 0–5 score per proposal label (complementary to the rubric aggregate). */
  per_proposal_scores: z.record(z.number()).default({}),
});

export type CouncilVerdict = z.infer<typeof CouncilVerdictSchema>;

// ── port ──────────────────────────────────────────────────────────────────────

/** A proposal as shown to critics/judge: anonymous label + content, never the author. */
export interface LabeledProposal {
  label: string;
  proposal: PlanProposal;
}

/** Extra context for a call; `repairHint` carries the validation error on the retry. */
export interface CouncilCallCtx {
  /** Optional project/repo context prepended to the task. */
  context?: string;
  /** Set on the single repair retry: the parse/validation error of the previous answer. */
  repairHint?: string;
}

/** Token usage of a single council call, when the backend reports it. */
export interface CouncilUsage {
  input: number;
  output: number;
}

/**
 * One council member. `propose`/`critique`/`judge` MUST return schema-valid objects or
 * throw (a `CouncilFormatError` for malformed JSON, so the orchestrator can retry with
 * the validation error as a hint). Implementations: HostClientAdapter (agent CLIs in
 * read-only mode) and ProviderClientAdapter (raw model with constrained decoding).
 */
export interface CouncilClientPort {
  readonly id: string;
  readonly kind: "host" | "provider";
  propose(task: string, ctx?: CouncilCallCtx): Promise<PlanProposal>;
  critique(anonProposals: LabeledProposal[], task: string, ctx?: CouncilCallCtx): Promise<PlanCritique[]>;
  judge(
    anonProposals: LabeledProposal[],
    critiques: PlanCritique[],
    task: string,
    ctx?: CouncilCallCtx,
  ): Promise<CouncilVerdict>;
  /** Usage of the LAST call, when the backend reports tokens (e.g. claude-code JSON output). */
  lastUsage?: CouncilUsage | null;
}

/**
 * Thrown when a client's answer is not the required JSON (unparseable, unbalanced, or
 * schema-invalid). The orchestrator retries ONCE quoting `message` back to the client;
 * a second failure turns into a no-vote for that round.
 */
export class CouncilFormatError extends Error {
  constructor(
    message: string,
    /** First chars of the raw answer, for the repair prompt + telemetry. */
    readonly raw?: string,
  ) {
    super(message);
    this.name = "CouncilFormatError";
  }
}
