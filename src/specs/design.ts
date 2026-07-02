/**
 * SDD phase D, step 2 (ADR-0042): derive a DESIGN DOC from the spec.
 *
 * The provider turns the spec into a short technical design (context, approach,
 * components, data & interfaces, risks), persisted as a first-class `type:"design"`
 * memory doc linked back to its spec via a `parent:` tag.
 */

import { embedOne } from "../ingest/embedder.js";
import { MemoryStore } from "../memory/store.js";
import { type MemoryDoc, makeMemoryDoc } from "../models/memory.model.js";
import type { Provider } from "../providers/base.js";

export interface DesignArgs {
  project: string;
  pipelineId: string;
  /** The spec body produced by ensureSpec. */
  spec: string;
  provider: Provider;
  repo?: string | null;
  store?: MemoryStore;
}

const DESIGN_INSTRUCTIONS = [
  "You write a SHORT technical design document for the given specification, in the spec's language.",
  "Reply with STRICT markdown only (no preamble) using exactly these sections:",
  "## Context — 2-3 sentences: what exists, what the spec changes.",
  "## Approach — the chosen approach in one short paragraph (state ONE alternative you rejected and why).",
  "## Components — bullets: modules/files to touch or add, one line each.",
  "## Data & interfaces — bullets: schemas, types or endpoints that change.",
  "## Risks — 2-4 bullets with a one-line mitigation each.",
  "Stay concrete and implementation-oriented; do not restate the whole spec.",
].join("\n");

/** Generate + persist the design doc. Returns slug + body. */
export async function generateDesign(args: DesignArgs): Promise<{ slug: string; body: string }> {
  const store = args.store ?? new MemoryStore();
  const id8 = args.pipelineId.slice(0, 8);

  const body = (await args.provider.complete(args.spec, { system: DESIGN_INSTRUCTIONS, maxTokens: 2000 })).trim();
  if (!body) throw new Error("sdd: the provider returned an empty design doc.");

  const slug = `sdd-design-${id8}`;
  const doc: MemoryDoc = makeMemoryDoc({
    project: args.project,
    slug,
    repo: args.repo ?? null,
    type: "design",
    category: "design",
    description: `SDD design doc for sdd-spec-${id8}`,
    body,
    tags: ["sdd", `run:${id8}`, `parent:sdd-spec-${id8}`],
  });
  try {
    doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
  } catch {
    // Embedding is optional; the doc is still text-searchable.
  }
  await store.upsertMemory(doc);
  return { slug, body };
}
