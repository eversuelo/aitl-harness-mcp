/**
 * SDD phase D, step 3 (ADR-0042): decompose spec + design into ordered TASKS.
 *
 * The provider must answer with STRICT JSON (same discipline as roles/engine.ts);
 * a malformed answer gets ONE repair retry (re-prompt with the parse error) before
 * failing loudly. Each task persists as a `type:"task"` memory doc linked to the
 * design via a `parent:` tag, so the whole chain spec → design → tasks is walkable.
 */

import { embedOne } from "../ingest/embedder.js";
import { MemoryStore } from "../memory/store.js";
import { type MemoryDoc, makeMemoryDoc } from "../models/memory.model.js";
import type { Provider } from "../providers/base.js";

export interface SddTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  files: string[];
}

export interface DecomposeArgs {
  project: string;
  pipelineId: string;
  spec: string;
  design: string;
  provider: Provider;
  repo?: string | null;
  store?: MemoryStore;
  /** Upper bound on generated tasks (default 10). */
  maxTasks?: number;
}

const TASKS_INSTRUCTIONS = (maxTasks: number) =>
  [
    "You decompose a specification + design into implementation tasks.",
    "Reply with STRICT JSON only — a single array, no prose, no code fences:",
    '[{"id":"t1","title":"…","description":"…","dependsOn":[],"files":["src/…"]}]',
    `Rules: at most ${maxTasks} tasks; ids t1..tN; dependsOn references earlier ids only;`,
    "each task independently verifiable; titles in the spec's language.",
  ].join("\n");

/** Defensive narrow of one parsed task (mirrors roles/engine's manual parsing). */
function narrowTask(v: unknown, n: number): SddTask | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!title) return null;
  return {
    id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : `t${n}`,
    title,
    description: typeof o.description === "string" ? o.description : "",
    dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.map(String) : [],
    files: Array.isArray(o.files) ? o.files.map(String) : [],
  };
}

/**
 * Extract the FIRST balanced JSON array from free-form text. A greedy regex
 * (`/\[[\s\S]*\]/`) over-matches when the model appends prose containing another
 * `]` after the array — found live with gemma-4 on LM Studio, so we walk brackets
 * (string- and escape-aware) instead.
 */
function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  if (start === -1) throw new Error("no JSON array found in the answer");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced JSON array in the answer");
}

function parseTasks(text: string, maxTasks: number): SddTask[] {
  const arr = JSON.parse(extractJsonArray(text)) as unknown;
  if (!Array.isArray(arr)) throw new Error("the JSON is not an array");
  const tasks = arr.map((v, i) => narrowTask(v, i + 1)).filter((t): t is SddTask => t !== null);
  if (!tasks.length) throw new Error("the array contains no valid task objects");
  return tasks.slice(0, maxTasks);
}

/** Decompose and persist the tasks. Returns the parsed tasks + their doc slugs. */
export async function decomposeTasks(args: DecomposeArgs): Promise<{ tasks: SddTask[]; slugs: string[] }> {
  const store = args.store ?? new MemoryStore();
  const id8 = args.pipelineId.slice(0, 8);
  const maxTasks = args.maxTasks ?? 10;
  const prompt = `# Spec\n${args.spec}\n\n# Design\n${args.design}`;

  let tasks: SddTask[];
  const first = await args.provider.complete(prompt, { system: TASKS_INSTRUCTIONS(maxTasks), maxTokens: 2000 });
  try {
    tasks = parseTasks(first, maxTasks);
  } catch (err) {
    // One repair retry: show the model its own answer and the parse error.
    const reason = err instanceof Error ? err.message : String(err);
    const retry = await args.provider.complete(
      `${prompt}\n\nYour previous answer could not be parsed (${reason}):\n${first.slice(0, 1000)}\n\nAnswer again with STRICT JSON only.`,
      { system: TASKS_INSTRUCTIONS(maxTasks), maxTokens: 2000 },
    );
    try {
      tasks = parseTasks(retry, maxTasks);
    } catch (err2) {
      const reason2 = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(`sdd: could not parse the tasks JSON after one retry (${reason2}).`);
    }
  }

  const slugs: string[] = [];
  for (const [i, t] of tasks.entries()) {
    const slug = `sdd-task-${id8}-${String(i + 1).padStart(2, "0")}`;
    const body = [
      `# ${t.id} — ${t.title}`,
      "",
      t.description || "_(no description)_",
      "",
      t.dependsOn.length ? `Depends on: ${t.dependsOn.join(", ")}` : "Depends on: —",
      t.files.length ? `Files: ${t.files.join(", ")}` : "Files: —",
      "",
      "```json",
      JSON.stringify(t, null, 2),
      "```",
    ].join("\n");
    const doc: MemoryDoc = makeMemoryDoc({
      project: args.project,
      slug,
      repo: args.repo ?? null,
      type: "task",
      category: "task",
      description: `SDD task ${t.id}: ${t.title}`.slice(0, 160),
      body,
      tags: ["sdd", `run:${id8}`, `parent:sdd-design-${id8}`],
    });
    try {
      doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
    } catch {
      // Embedding is optional; the doc is still text-searchable.
    }
    await store.upsertMemory(doc);
    slugs.push(slug);
  }
  return { tasks, slugs };
}
