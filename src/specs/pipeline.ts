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
    const run = makeRun({ project: opts.project, model: provider.name, harness_config: { sdd: true } });
    await RunModel.create({ ...run, _id: pipelineId });
  }
  // Phase telemetry reuses the existing `synthesis` event type (payload.kind disambiguates).
  const logPhase = async (kind: string, slug: string): Promise<void> => {
    try {
      await store.logEvent(
        makeEvent({
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
