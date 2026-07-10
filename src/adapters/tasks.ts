/**
 * Tasks adapter: one-shot Mongo → `<root>/tasks/<slug>.md` (ADR-0062).
 *
 * Unlike the repo-rooted adapters, `--root` here IS the export directory: the point
 * is materializing the SDD task docs (memory `type:"task"`) as reviewable markdown
 * wherever the user asks — `aitl export --adapter tasks --root ./out` writes
 * `./out/tasks/*.md`. The chat REPL's `/export <dir>` uses the same exporter.
 */

import { exportTasks } from "../sync/export.js";
import type { Canon, ToolAdapter } from "./base.js";

export class TasksAdapter implements ToolAdapter {
  readonly name = "tasks";

  async export(canon: Canon, repoRoot: string): Promise<string[]> {
    const res = await exportTasks(canon.project, repoRoot);
    for (const s of res.skipped) console.error(`[tasks] skipped ${s.path}: ${s.reason}`);
    return res.written;
  }
}
