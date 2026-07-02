/**
 * SDD phase D, step 1 (ADR-0042): ensure a SPEC exists for a prompt.
 *
 * If the prompt already classifies as a spec (classifySpec, deterministic), it is
 * persisted VERBATIM — the engineer's words are the spec of record. Otherwise the
 * provider formalizes the ad-hoc task into a minimal spec (user story + acceptance
 * criteria). Either way the artifact lands as a first-class `type:"spec"` memory doc.
 */

import { randomUUID } from "node:crypto";
import { embedOne } from "../ingest/embedder.js";
import { MemoryStore } from "../memory/store.js";
import { type MemoryDoc, makeMemoryDoc } from "../models/memory.model.js";
import type { Provider } from "../providers/base.js";
import { classifySpec } from "./classify.js";

export interface EnsureSpecArgs {
  project: string;
  /** Pipeline id (uuid); its first 8 chars key every artifact slug/tag. */
  pipelineId: string;
  prompt: string;
  provider: Provider;
  repo?: string | null;
  store?: MemoryStore;
}

const SPEC_INSTRUCTIONS = [
  "You formalize a software task into a MINIMAL specification, in the same language as the task.",
  "Reply with STRICT markdown only (no preamble, no commentary) using exactly these sections:",
  "## User story — one 'As a … I want … so that …' sentence (or 'Como … quiero … para …').",
  "## Acceptance criteria — 3-6 Given/When/Then bullets ('Dado/Cuando/Entonces').",
  "## Out of scope — 1-3 bullets of what this task explicitly does NOT cover.",
  "Do not invent requirements beyond what the task implies.",
].join("\n");

/** Persist the spec for `prompt` (verbatim or generated). Returns slug + body. */
export async function ensureSpec(
  args: EnsureSpecArgs,
): Promise<{ slug: string; body: string; generated: boolean }> {
  const store = args.store ?? new MemoryStore();
  const id8 = args.pipelineId.slice(0, 8);
  const cls = classifySpec(args.prompt);

  let body: string;
  let generated: boolean;
  if (cls.isSpec) {
    body = args.prompt.trim();
    generated = false;
  } else {
    body = (await args.provider.complete(args.prompt, { system: SPEC_INSTRUCTIONS, maxTokens: 1500 })).trim();
    if (!body) throw new Error("sdd: the provider returned an empty spec.");
    generated = true;
  }

  const firstLine = args.prompt.trim().split("\n")[0].slice(0, 120);
  const slug = `sdd-spec-${id8}`;
  const doc: MemoryDoc = makeMemoryDoc({
    project: args.project,
    slug,
    repo: args.repo ?? null,
    type: "spec",
    category: "spec",
    description: `SDD spec — ${firstLine}${generated ? " (generated)" : ""}`,
    body,
    tags: ["sdd", `run:${id8}`],
  });
  try {
    doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
  } catch {
    // Embedding is optional; the doc is still text-searchable.
  }
  await store.upsertMemory(doc);
  return { slug, body, generated };
}

/** Convenience for callers that don't bring their own pipeline id. */
export const newPipelineId = (): string => randomUUID();
