/**
 * Spec classifier — decides, deterministically and model-free, whether a prompt is a
 * specification (Spec-Driven Development input) rather than an ad-hoc task.
 *
 * Pillar 4 (SDD) of the harness plan persists spec artifacts; this is the auto-detection
 * trigger the user asked for (no explicit flag). Signals are bilingual (ES/EN) because the
 * engineer writes specs in Spanish and English. The classifier is pure: same input →
 * same output, so it is safe inside `runOnHost` and easily unit-tested.
 */

export interface SpecClassification {
  /** Whether the prompt should be treated as a spec (SDD input). */
  isSpec: boolean;
  /** Weighted signal score (strong signals count double). */
  score: number;
  /** Names of the matched signals, for traceability/telemetry. */
  signals: string[];
}

// [regex, signal-name]. Strong signals (see STRONG) are near-certain spec markers.
const SIGNALS: [RegExp, string][] = [
  [/^#{1,6}\s*(spec(ification)?|especificaci[oó]n)\b/im, "heading:spec"],
  [/\b(acceptance criteria|criterios? de aceptaci[oó]n)\b/i, "acceptance-criteria"],
  [/\b(user stor(y|ies)|historias? de usuario)\b/i, "user-story"],
  [/\bas an?\b[\s\S]{0,80}\bi want\b[\s\S]{0,80}\bso that\b/i, "as-a-i-want"],
  [/\bcomo\b[\s\S]{0,80}\bquiero\b[\s\S]{0,80}\bpara\b/i, "como-quiero-para"],
  [/\b(given|dado)\b[\s\S]{0,120}\b(when|cuando)\b[\s\S]{0,120}\b(then|entonces)\b/i, "gherkin"],
  [/\b(definition of done|definici[oó]n de hecho|\bDoD\b)\b/i, "dod"],
  [/\b(requirements?|requisitos?|functional requirements?)\b\s*:?/i, "requirements"],
  [/^#{1,6}\s*(design|dise[ñn]o|tasks?|tareas?|plan|scope|alcance)\b/im, "sdd-section"],
  [/\b(must|shall|should|deber[aá]|debe(r[aá]n)?)\b/i, "normative"],
  [/^\s*(?:[-*]|\d+[.)])\s+.+(?:\n\s*(?:[-*]|\d+[.)])\s+.+){3,}/m, "structured-list"],
];

// Signals strong enough that a single match (in a non-trivial prompt) implies a spec.
const STRONG = new Set([
  "heading:spec",
  "acceptance-criteria",
  "user-story",
  "as-a-i-want",
  "como-quiero-para",
  "gherkin",
  "dod",
]);

/** Minimum length (chars) for a strong-signal match to count as a spec (filters one-liners). */
const MIN_SPEC_LEN = 200;

/** Classify a prompt as spec vs ad-hoc task (deterministic, model-free). */
export function classifySpec(prompt: string): SpecClassification {
  const text = prompt ?? "";
  const signals: string[] = [];
  for (const [rx, name] of SIGNALS) if (rx.test(text)) signals.push(name);

  const strong = signals.filter((s) => STRONG.has(s)).length;
  const score = strong * 2 + (signals.length - strong);
  const longEnough = text.trim().length >= MIN_SPEC_LEN;

  // Spec if: a strong marker in a non-trivial prompt, OR a high overall score,
  // OR several weaker signals co-occur in a non-trivial prompt.
  const isSpec = (strong >= 1 && longEnough) || score >= 4 || (signals.length >= 3 && longEnough);
  return { isSpec, score, signals };
}
