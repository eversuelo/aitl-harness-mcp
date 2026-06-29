/**
 * Spec ↔ task synthesis — compresses a spec-driven host run into ONE durable, classified,
 * embedded memory doc that joins the SPEC with the TASK OUTCOME and its measured metrics.
 *
 * This is the "synthesize the spec with the task" half of Pillar 4 (SDD): after a host run
 * whose prompt was classified as a spec, we persist a synthesis (type="synthesis") so the
 * spec, what the agent delivered, and the token/turn/cost metrics live together and are
 * searchable. Deterministic by design (no model call) — `runOnHost` drives an external host
 * and has no Provider, and the user's fallback scenario is precisely "no OpenRouter key".
 */

import { embedOne } from "../ingest/embedder.js";
import { type MemoryDoc, makeMemoryDoc } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";

export interface SpecSynthesisArgs {
  project: string;
  runId: string;
  spec: string; // the spec prompt
  outcome: string; // the host's final output
  signals: string[]; // spec signals that triggered classification
  usage: { input: number; output: number };
  meta?: Record<string, unknown> | null; // host meta (cost_usd, num_turns, duration_ms…)
  status: string;
  host: string;
  store?: MemoryStore;
}

const EXCERPT = 4000;

/** Write the spec↔task synthesis doc. Returns its slug. */
export async function synthesizeSpecRun(args: SpecSynthesisArgs): Promise<{ slug: string }> {
  const store = args.store ?? new MemoryStore();
  const total = args.usage.input + args.usage.output;
  const m = args.meta ?? {};

  const body = [
    `# Spec ↔ task synthesis — run ${args.runId.slice(0, 8)} (host: ${args.host})`,
    "",
    "## Spec",
    args.spec.trim().slice(0, EXCERPT) || "_(empty spec)_",
    "",
    `## Outcome (${args.status})`,
    args.outcome.trim().slice(0, EXCERPT) || "_(no output)_",
    "",
    "## Metrics",
    `- tokens: input=${args.usage.input}, output=${args.usage.output}, total=${total}`,
    m.cost_usd != null ? `- cost_usd: ${m.cost_usd}` : null,
    m.num_turns != null ? `- num_turns: ${m.num_turns}` : null,
    m.duration_ms != null ? `- duration_ms: ${m.duration_ms}` : null,
    `- spec_signals: ${args.signals.join(", ") || "—"}`,
    `- run_id: ${args.runId}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const slug = `spec-synthesis-${args.runId.slice(0, 8)}`;
  const doc: MemoryDoc = makeMemoryDoc({
    project: args.project,
    slug,
    type: "synthesis",
    category: "spec",
    description: `Spec ↔ task synthesis — run ${args.runId.slice(0, 8)} (${total} tok, ${args.status})`,
    body,
    tags: ["synthesis", "spec", "sdd", `run:${args.runId.slice(0, 8)}`],
  });
  try {
    doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
  } catch {
    // Embedding is optional; the doc is still text-searchable.
  }
  await store.upsertMemory(doc);
  return { slug };
}
