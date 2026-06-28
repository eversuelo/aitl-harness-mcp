/**
 * Role engine (H11) — runs the three coupling modes and produces a DecisionBrief
 * that ASSISTS the Software Engineer's decision (it never decides for them):
 *
 *   - gate(role)        : a deterministic PermissionGate (blocking, no model needed).
 *   - reviewWithRole()  : a model-based critique through the role's lens (advice).
 *   - deliberate()      : runs every role over a target, attributes objections per
 *                         role, and emits review/deliberation events for traceability.
 *
 * Objections are always attributed to their role so the engineer can see the
 * criteria behind a decision (the H11 traceability claim).
 */

import { denyPathsGate } from "../hooks/gates.js";
import { makeEvent } from "../memory/schemas.js";
import type { MemoryStore } from "../memory/store.js";
import type { PermissionGate } from "../tools/base.js";
import type { DecisionBrief, Role, RoleVerdict } from "./schema.js";

/** Structural provider type — engine stays decoupled from a concrete Provider. */
export interface RoleReviewProvider {
  chat(messages: { role: string; content: string }[], opts?: { system?: string }): Promise<{ text: string }>;
}

/** A deterministic blocking gate for a `gate`-mode role (its denyGlobs). No model. */
export function roleGate(role: Role): PermissionGate {
  const base = denyPathsGate(role.denyGlobs);
  return (name, args) => {
    const [allowed, reason] = base(name, args);
    if (!allowed) return [false, `[role:${role.name}] ${reason}`];
    return [true, ""];
  };
}

const REVIEW_INSTRUCTIONS = [
  "You are an engineering reviewer ASSISTING a Software Engineer's decision — you do not decide.",
  "Review the target through your lens and reply with STRICT JSON only:",
  '{"stance":"approve|concerns|block","findings":["..."],"recommendation":"..."}',
  "stance: approve (nothing to raise), concerns (advisory findings), block (hard objection).",
  "Keep findings specific and actionable so the engineer can decide with more criteria.",
].join("\n");

/** Parse the model's JSON verdict defensively. */
function parseVerdict(role: Role, text: string): RoleVerdict {
  let stance: RoleVerdict["stance"] = "concerns";
  let findings: string[] = [];
  let recommendation = "";
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : {};
    if (obj.stance === "approve" || obj.stance === "block" || obj.stance === "concerns") stance = obj.stance;
    if (Array.isArray(obj.findings)) findings = obj.findings.map(String);
    recommendation = String(obj.recommendation ?? "");
  } catch {
    findings = [text.replace(/\s+/g, " ").slice(0, 300)];
  }
  // A blocking-severity role's "block" stance is a hard objection; advisory roles soften to concerns.
  if (stance === "block" && role.severity !== "blocking") stance = "concerns";
  return { role: role.name, mode: role.mode, severity: role.severity, stance, findings, recommendation };
}

/** Critique a target through one role's lens (needs a provider/model). */
export async function reviewWithRole(role: Role, target: string, provider: RoleReviewProvider): Promise<RoleVerdict> {
  const system = `${REVIEW_INSTRUCTIONS}\n\n## Your lens (${role.name})\n${role.lens}`;
  const turn = await provider.chat([{ role: "user", content: `Review this target:\n\n${target}` }], { system });
  return parseVerdict(role, turn.text ?? "");
}

export interface DeliberateOpts {
  project: string;
  target: string;
  roles: Role[];
  provider: RoleReviewProvider;
  store?: MemoryStore;
  runId?: string | null;
}

/**
 * Run every role over the target, attribute objections, emit traceable events, and
 * return a DecisionBrief for the engineer. Blocked = any blocking-severity role blocks.
 */
export async function deliberate(opts: DeliberateOpts): Promise<DecisionBrief> {
  const { project, target, roles, provider, store, runId } = opts;
  const verdicts: RoleVerdict[] = [];
  for (const role of roles) {
    const v = await reviewWithRole(role, target, provider);
    verdicts.push(v);
    if (store) {
      const type = v.stance === "block" ? "role_veto" : "review";
      await store.logEvent(makeEvent({ project, run_id: runId ?? null, type, payload: { role: v.role, mode: v.mode, severity: v.severity, stance: v.stance, findings: v.findings, recommendation: v.recommendation } }));
    }
  }
  const blocked = verdicts.some((v) => v.severity === "blocking" && v.stance === "block");
  const concerns = verdicts.filter((v) => v.stance !== "approve").length;
  const summary = blocked
    ? `BLOCKED por ${verdicts.filter((v) => v.stance === "block").map((v) => v.role).join(", ")}. El ingeniero decide con estos criterios.`
    : concerns > 0
      ? `${concerns} rol(es) con observaciones (advisory). Sin bloqueos; el ingeniero decide.`
      : "Todos los roles aprueban. Sin objeciones.";
  if (store) {
    await store.logEvent(makeEvent({ project, run_id: runId ?? null, type: "deliberation", payload: { target: target.slice(0, 200), blocked, roles: verdicts.map((v) => ({ role: v.role, stance: v.stance })) } }));
  }
  return { target, verdicts, blocked, summary };
}
