/**
 * Engineering roles (H11) — composable review layers that ASSIST the Software
 * Engineer's decision with better criteria. A role is an overlay over the harness
 * primitives (persona/lens + skills + permission profile + model binding) with a
 * coupling mode to the loop:
 *
 *   - review : checkpoint critique (at end of a phase / pre-PR) — advisory by default.
 *   - pair   : continuous accompaniment (advises after each edit) — advisory.
 *   - gate   : blocking veto for hard constraints (secrets, ADR violations).
 *
 * Roles never decide for the human; they produce a structured DecisionBrief
 * (objections attributed per role + a recommendation) so the engineer decides with
 * more criteria, and the objections are traceable.
 *
 * Stored in the `agents` collection (no new collection) discriminated by
 * metadata.kind === "role" (see store.ts).
 */

import { z } from "zod";

export const ROLE_MODES = ["review", "pair", "gate"] as const;
export const ROLE_SEVERITIES = ["advisory", "blocking"] as const;
export const ROLE_HOSTS = ["model", "claude-code", "codex", "antigravity"] as const;

export const RoleBindingSchema = z.object({
  host: z.enum(ROLE_HOSTS).default("model"),
  model: z.string().nullable().default(null),
});
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const RoleSchema = z.object({
  name: z.string(), // "security", "devops", "qa", "architect"
  lens: z.string(), // persona / focus prompt — what this role looks for
  mode: z.enum(ROLE_MODES).default("review"),
  severity: z.enum(ROLE_SEVERITIES).default("advisory"),
  // Tool names / path globs that activate this role (pair/gate), e.g. "write_file" or auth-path globs.
  triggers: z.array(z.string()).default([]),
  // Deny-globs for gate mode (hard blocks), e.g. secret/key path patterns for Security.
  denyGlobs: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]), // referenced skill names
  binding: RoleBindingSchema.default({ host: "model", model: null }),
  description: z.string().default(""),
});
export type Role = z.infer<typeof RoleSchema>;

export const makeRole = (v: z.input<typeof RoleSchema>): Role => RoleSchema.parse(v);

/** One role's contribution to the engineer's decision (assist, not decide). */
export interface RoleVerdict {
  role: string;
  mode: string;
  severity: string;
  /** approve = no concerns; concerns = advisory findings; block = hard objection. */
  stance: "approve" | "concerns" | "block";
  findings: string[];
  recommendation: string;
}

/** The artifact handed to the Software Engineer to decide with more criteria. */
export interface DecisionBrief {
  target: string;
  verdicts: RoleVerdict[];
  /** true if any blocking-severity role objected — the human still decides. */
  blocked: boolean;
  summary: string;
}
