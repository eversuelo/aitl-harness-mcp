/**
 * Evaluation harness.
 *
 * The thesis's headline result is the *delta*: how much the harness (durable memory +
 * repo map + conventions + hooks) improves task success over the bare model — measured
 * across at least two different models to show the gain is model-agnostic.
 *
 * This module defines the runner contract and a pluggable Benchmark interface. The
 * concrete dataset adapters (SWE-bench Verified, Terminal-Bench, Aider polyglot) are
 * intentionally left as TODOs because they require downloading external datasets and
 * sandboxed execution environments; each has a clear note of what to implement.
 */

import { getProvider } from "../providers/base.js";
import { runAgent } from "../orchestration/graph.js";

export interface BenchmarkTask {
  id: string;
  prompt: string;
  [k: string]: unknown;
}

export interface Benchmark {
  readonly name: string;
  tasks(): Promise<BenchmarkTask[]>;
  verify(task: BenchmarkTask, workdir: string): Promise<boolean>;
}

export interface EvalResult {
  benchmark: string;
  model: string;
  harness: boolean;
  total: number;
  passed: number;
}

export const rate = (r: EvalResult): number => (r.total ? r.passed / r.total : 0);

/** Run a benchmark with and without the harness, for one or more models. */
export class EvalRunner {
  constructor(private benchmark: Benchmark) {}

  async run(
    models: string[],
    opts: { project?: string; bareSolver?: (model: string, prompt: string) => Promise<string> } = {},
  ): Promise<EvalResult[]> {
    const project = opts.project ?? "eval";
    const results: EvalResult[] = [];
    const tasks = await this.benchmark.tasks();

    for (const model of models) {
      // With harness: full runAgent loop (durable memory, tools, repo map).
      let passed = 0;
      for (const t of tasks) {
        await runAgent(t.prompt, project, { provider: await getProvider(model) });
        // NOTE: verify() needs the task workdir; wire this when the concrete
        // benchmark sandbox is implemented.
        // passed += (await this.benchmark.verify(t, workdir)) ? 1 : 0;
      }
      results.push({ benchmark: this.benchmark.name, model, harness: true, total: tasks.length, passed });

      // Bare model baseline: single completion, no harness scaffolding.
      if (opts.bareSolver) {
        let bpass = 0;
        for (const t of tasks) {
          await opts.bareSolver(model, t.prompt);
          // bpass += (await this.benchmark.verify(t, workdir)) ? 1 : 0;
        }
        results.push({ benchmark: this.benchmark.name, model, harness: false, total: tasks.length, passed: bpass });
      }
    }
    return results;
  }
}

// TODO(phase 8): implement concrete benchmarks (parity with Python eval/runner.py):
//   - SweBenchVerified: princeton-nlp/SWE-bench_Verified (500 tasks); apply patch per
//     git repo; verify with the gold test set.
//   - TerminalBench: tbench.ai task suite; verify via the provided harness checker.
//   - AiderPolyglot: 225 Exercism problems across 6 languages; verify with unit tests.
