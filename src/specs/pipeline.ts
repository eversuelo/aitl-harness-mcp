/**
 * SDD phase D pipeline (ADR-0042): prompt → spec → design → tasks, every artifact
 * persisted as a first-class memory doc chained by tags
 * (`run:<id8>`, `parent:<slug>`), plus one Run doc so the pipeline shows up in the
 * existing Runs telemetry (UI tab, run-show) with zero new UI.
 */

import { randomUUID } from "node:crypto";
import { ensureMongoose } from "../db/mongoose.js";
import { MemoryStore } from "../memory/store.js";
import { makeEvent } from "../models/event.model.js";
import type { MemoryDoc } from "../models/memory.model.js";
import { RunModel, makeRun } from "../models/run.model.js";
import { type Provider, getProvider } from "../providers/base.js";
import { decomposeTasks, type SddTask } from "./decompose.js";
import { generateDesign } from "./design.js";
import { ensureSpec } from "./spec.js";

export interface SddPipelineOpts {
  project: string;
  provider?: Provider;
  /** Provider name for getProvider when no instance is passed (primary by default). */
  model?: string;
  repo?: string | null;
  store?: MemoryStore;
  /** Create a Run doc + events in Mongo (default true; tests pass false). */
  persistRun?: boolean;
  maxTasks?: number;
}

export interface SddPipelineResult {
  pipeline_id: string;
  spec_slug: string;
  generated_spec: boolean;
  design_slug: string;
  task_slugs: string[];
  tasks: SddTask[];
}

export async function runSddPipeline(prompt: string, opts: SddPipelineOpts): Promise<SddPipelineResult> {
  const provider = opts.provider ?? (await getProvider(opts.model));
  const store = opts.store ?? new MemoryStore();
  const pipelineId = randomUUID();
  const persist = opts.persistRun !== false;

  if (persist) {
    await ensureMongoose();
    const run = await makeRun({ project: opts.project, model: provider.name, harness_config: { sdd: true } });
    await RunModel.create({ ...run, _id: pipelineId });
  }
  // Phase telemetry reuses the existing `synthesis` event type (payload.kind disambiguates).
  const logPhase = async (kind: string, slug: string): Promise<void> => {
    try {
      await store.logEvent(
        await makeEvent({
          project: opts.project,
          run_id: persist ? pipelineId : null,
          type: "synthesis",
          payload: { sdd: true, kind, slug },
        }),
      );
    } catch {
      // telemetry is best-effort
    }
  };

  const shared = { project: opts.project, pipelineId, provider, repo: opts.repo ?? null, store };
  try {
    const spec = await ensureSpec({ ...shared, prompt });
    await logPhase("spec", spec.slug);

    const design = await generateDesign({ ...shared, spec: spec.body });
    await logPhase("design", design.slug);

    const { tasks, slugs } = await decomposeTasks({
      ...shared,
      spec: spec.body,
      design: design.body,
      maxTasks: opts.maxTasks,
    });
    await logPhase("tasks", slugs.join(","));

    if (persist) {
      await RunModel.updateOne(
        { _id: pipelineId },
        { $set: { status: "done", ended_at: new Date(), spec: true, tags: ["sdd"] } },
      );
    }
    return {
      pipeline_id: pipelineId,
      spec_slug: spec.slug,
      generated_spec: spec.generated,
      design_slug: design.slug,
      task_slugs: slugs,
      tasks,
    };
  } catch (err) {
    if (persist) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      await RunModel.updateOne(
        { _id: pipelineId },
        { $set: { status: "error", ended_at: new Date(), error: message } },
      ).catch(() => {});
    }
    throw err;
  }
}

// ── preview mode (TUI Task → Planear) ─────────────────────────────────────────

/**
 * In-memory sink for preview mode: buffers every artifact upsert and drops telemetry
 * events. Duck-typed to the MemoryStore surface the SDD steps actually use
 * (`upsertMemory` + `logEvent`) — the same seam the SDD unit tests rely on.
 */
class BufferMemoryStore {
  docs: MemoryDoc[] = [];
  async upsertMemory(doc: MemoryDoc): Promise<string> {
    this.docs.push(doc);
    return doc.slug;
  }
  async logEvent(): Promise<void> {
    // preview never persists telemetry
  }
}

export interface SddPreview {
  result: SddPipelineResult;
  /** Generated artifacts (spec → design → tasks, in order) — NOT persisted yet. */
  artifacts: MemoryDoc[];
  /** Persist the buffered artifacts as spec/design/task memories. Idempotent; returns slugs. */
  persist(store?: MemoryStore): Promise<string[]>;
}

/**
 * Run the SDD pipeline WITHOUT persisting anything (no Run doc, no memories, no
 * events): the artifacts are buffered so a caller can show them to the human first
 * and only then `persist()` them — the confirm-before-write flow of the TUI's
 * Planear action. Generation still needs a model provider; Mongo is only touched
 * when (and if) `persist()` runs.
 */
export async function runSddPipelinePreview(
  prompt: string,
  opts: Omit<SddPipelineOpts, "store" | "persistRun">,
): Promise<SddPreview> {
  const buffer = new BufferMemoryStore();
  const result = await runSddPipeline(prompt, {
    ...opts,
    store: buffer as unknown as MemoryStore,
    persistRun: false,
  });
  let persisted = false;
  return {
    result,
    artifacts: buffer.docs,
    async persist(store?: MemoryStore): Promise<string[]> {
      if (persisted) return buffer.docs.map((d) => d.slug);
      const real = store ?? new MemoryStore();
      const slugs: string[] = [];
      for (const doc of buffer.docs) slugs.push(await real.upsertMemory(doc));
      persisted = true;
      return slugs;
    },
  };
}
