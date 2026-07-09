/**
 * LoopSpec — the loop policy as a VERSIONED SPECIFICATION (loop engineering).
 *
 * Instead of `maxIters` being an ad-hoc knob, the whole termination/budget/verify
 * policy of `runAgent` is a declarative artifact: loadable from a JSON file (versioned
 * in git) or from the durable `loops` collection (DefinitionStore kind "loop"), and
 * identified by a content-hash version. Every run stamps `loop_spec@version` into its
 * `harness_config`, so any measurement can state EXACTLY which loop design produced it.
 *
 * Precedence when resolving the effective policy: explicit RunAgentOpts > LoopSpec >
 * built-in defaults — a spec never silently overrides what the caller asked for.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const LoopSpecSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** Iteration window; refreshed on each granted verify round. */
    maxIters: z.number().int().positive().optional(),
    /** Hard budgets checked at the top of every iteration. */
    budgets: z
      .object({
        tokens: z.number().int().positive().optional(),
        ms: z.number().int().positive().optional(),
      })
      .optional(),
    /** Consecutive no-progress iterations that trip the stall detector (0 disables). */
    stallThreshold: z.number().int().min(0).optional(),
    /** Verify-failure feedback rounds granted before the run ends `verify_exhausted`. */
    maxVerifyRounds: z.number().int().min(0).optional(),
    /** Force a no-tools diagnosis turn after each failed verification. */
    reflect: z.boolean().optional(),
    /** Shell command whose exit status verifies the run (CLI convenience). */
    verifyCmd: z.string().optional(),
  })
  .strict();

export type LoopSpec = z.infer<typeof LoopSpecSchema>;

/** Built-in defaults — the pre-LoopSpec behaviour of `runAgent`. */
export const LOOP_DEFAULTS = {
  maxIters: 12,
  stallThreshold: 3,
  maxVerifyRounds: 3,
  reflect: false,
} as const;

/** Deterministic content-hash version of a spec (order-independent field dump). */
export function loopSpecVersion(spec: LoopSpec): string {
  const canonical = JSON.stringify(spec, Object.keys(spec).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export interface LoopSpecRef {
  name: string;
  version: string;
  source: "file" | "store" | "inline";
}

/** True when the argument names a JSON file rather than a stored spec. */
export function isSpecPath(nameOrPath: string): boolean {
  return nameOrPath.endsWith(".json") || nameOrPath.includes("/") || nameOrPath.startsWith(".");
}

/** Load a spec from a JSON file (versioned in git; version = content hash). */
export async function loadLoopSpecFile(
  path: string,
): Promise<{ spec: LoopSpec; ref: LoopSpecRef }> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const spec = LoopSpecSchema.parse(raw);
  return { spec, ref: { name: spec.name, version: loopSpecVersion(spec), source: "file" } };
}

/** Resolve `--loop-spec <nameOrPath>`: JSON file if path-like, else the `loops` collection. */
export async function loadLoopSpecAuto(
  project: string,
  nameOrPath: string,
): Promise<{ spec: LoopSpec; ref: LoopSpecRef }> {
  if (isSpecPath(nameOrPath)) return loadLoopSpecFile(nameOrPath);
  const found = await loadLoopSpecFromStore(project, nameOrPath);
  if (!found) throw new Error(`loop spec '${nameOrPath}' not found for project '${project}'`);
  return found;
}

/** Load a named spec from the `loops` collection for a project. */
export async function loadLoopSpecFromStore(
  project: string,
  name: string,
): Promise<{ spec: LoopSpec; ref: LoopSpecRef } | null> {
  const { DefinitionStore } = await import("../projectctx/store.js");
  const rec = await new DefinitionStore("loop").get(project, name);
  if (!rec) return null;
  const spec = LoopSpecSchema.parse(JSON.parse(rec.content || "{}"));
  return { spec, ref: { name: spec.name, version: loopSpecVersion(spec), source: "store" } };
}

/** Persist a spec to the `loops` collection (content = spec JSON, metadata.version = hash). */
export async function saveLoopSpec(project: string, spec: LoopSpec): Promise<LoopSpecRef> {
  const parsed = LoopSpecSchema.parse(spec);
  const version = loopSpecVersion(parsed);
  const { DefinitionStore } = await import("../projectctx/store.js");
  await new DefinitionStore("loop").upsert({
    project,
    name: parsed.name,
    description: parsed.description ?? "",
    content: JSON.stringify(parsed, null, 2),
    tags: ["loopspec"],
    metadata: { version },
  });
  return { name: parsed.name, version, source: "store" };
}

/** The effective, fully-resolved loop policy a run executes under. */
export interface LoopPolicy {
  maxIters: number;
  budgets?: { tokens?: number; ms?: number };
  stallThreshold: number;
  maxVerifyRounds: number;
  reflect: boolean;
  /** Which spec (if any) the policy came from — stamped into harness_config. */
  specRef: LoopSpecRef | null;
}

/** Caller-supplied overrides (mirrors the loop-related RunAgentOpts). */
export interface LoopPolicyOverrides {
  maxIters?: number;
  budgets?: { tokens?: number; ms?: number };
  stallThreshold?: number;
  maxVerifyRounds?: number;
  reflect?: boolean;
}

/** Pure precedence merge: explicit opts > spec > defaults. */
export function resolveLoopPolicy(
  overrides: LoopPolicyOverrides = {},
  spec?: LoopSpec | null,
  ref: LoopSpecRef | null = null,
): LoopPolicy {
  return {
    maxIters: overrides.maxIters ?? spec?.maxIters ?? LOOP_DEFAULTS.maxIters,
    budgets: overrides.budgets ?? spec?.budgets,
    stallThreshold:
      overrides.stallThreshold ?? spec?.stallThreshold ?? LOOP_DEFAULTS.stallThreshold,
    maxVerifyRounds:
      overrides.maxVerifyRounds ?? spec?.maxVerifyRounds ?? LOOP_DEFAULTS.maxVerifyRounds,
    reflect: overrides.reflect ?? spec?.reflect ?? LOOP_DEFAULTS.reflect,
    specRef: ref,
  };
}

/** True when the run's cumulative usage breaches any configured budget. */
export function budgetBreached(
  budgets: { tokens?: number; ms?: number } | undefined,
  usage: { tokens: number; ms: number },
): "tokens" | "ms" | null {
  if (!budgets) return null;
  if (budgets.tokens !== undefined && usage.tokens >= budgets.tokens) return "tokens";
  if (budgets.ms !== undefined && usage.ms >= budgets.ms) return "ms";
  return null;
}
