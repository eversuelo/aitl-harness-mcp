import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryStore } from "../memory/store.js";
import type { MemoryDoc } from "../models/memory.model.js";
import type { Provider } from "../providers/base.js";
import { runSddPipeline } from "./pipeline.js";

/** Captures upserts/events in memory — no Mongo. */
class FakeStore {
  docs: MemoryDoc[] = [];
  events: Record<string, unknown>[] = [];
  async upsertMemory(doc: MemoryDoc): Promise<string> {
    this.docs.push(doc);
    return doc.slug;
  }
  async logEvent(ev: Record<string, unknown>): Promise<void> {
    this.events.push(ev);
  }
}

/** Canned provider: routes on the system instructions; decompose answers come from a queue. */
class FakeProvider {
  readonly name = "fake";
  taskAnswers: string[];
  completions = 0;
  constructor(taskAnswers: string[]) {
    this.taskAnswers = [...taskAnswers];
  }
  async complete(_prompt: string, opts: { system?: string } = {}): Promise<string> {
    this.completions += 1;
    const sys = opts.system ?? "";
    if (sys.includes("STRICT JSON")) return this.taskAnswers.shift() ?? "[]";
    if (sys.includes("design document")) return "## Context\nx\n## Approach\ny\n## Components\n- a\n## Data & interfaces\n- b\n## Risks\n- c";
    return "## User story\nAs a user I want X so that Y.\n## Acceptance criteria\n- Given/When/Then.\n## Out of scope\n- Z.";
  }
  async chat(): Promise<never> {
    throw new Error("not used");
  }
  countTokens(): number {
    return 0;
  }
  capabilities() {
    return { toolUse: false, jsonMode: false, maxContext: 0, streaming: false, caching: false, hostAdapter: false };
  }
}

const GOOD_TASKS = JSON.stringify([
  { id: "t1", title: "Add endpoint", description: "…", dependsOn: [], files: ["src/api.ts"] },
  { id: "t2", title: "Add tests", description: "…", dependsOn: ["t1"], files: ["src/api.test.ts"] },
]);

const SPEC_PROMPT = `## Historia de usuario

Como administrador quiero exportar reportes CSV para auditar tenants.

## Criterios de aceptación
- Dado un tenant, cuando exporto, entonces obtengo un CSV con sus filas.
- El sistema debe rechazar tenants ajenos.
`;

function run(prompt: string, provider: FakeProvider, store = new FakeStore()) {
  return runSddPipeline(prompt, {
    project: "demo",
    provider: provider as unknown as Provider,
    store: store as unknown as MemoryStore,
    persistRun: false,
  }).then((res) => ({ res, store }));
}

test("a spec-shaped prompt is persisted VERBATIM (not regenerated)", async () => {
  const { res, store } = await run(SPEC_PROMPT, new FakeProvider([GOOD_TASKS]));
  assert.equal(res.generated_spec, false);
  const spec = store.docs.find((d) => d.type === "spec");
  assert.ok(spec);
  assert.equal(spec.body, SPEC_PROMPT.trim());
});

test("an ad-hoc task gets a generated spec", async () => {
  const { res, store } = await run("fix the login button", new FakeProvider([GOOD_TASKS]));
  assert.equal(res.generated_spec, true);
  const spec = store.docs.find((d) => d.type === "spec");
  assert.match(String(spec?.body), /User story/);
});

test("the pipeline persists 1 spec + 1 design + N tasks, chained by tags", async () => {
  const { res, store } = await run(SPEC_PROMPT, new FakeProvider([GOOD_TASKS]));
  const id8 = res.pipeline_id.slice(0, 8);
  const byType = (t: string) => store.docs.filter((d) => String(d.type) === t);
  assert.equal(byType("spec").length, 1);
  assert.equal(byType("design").length, 1);
  assert.equal(byType("task").length, 2);
  // Chain: everything carries run:<id8>; children point at their parent.
  for (const d of store.docs) assert.ok(d.tags.includes(`run:${id8}`), `${d.slug} tagged with the run`);
  assert.ok(byType("design")[0].tags.includes(`parent:sdd-spec-${id8}`));
  for (const t of byType("task")) assert.ok(t.tags.includes(`parent:sdd-design-${id8}`));
  assert.deepEqual(res.task_slugs, [`sdd-task-${id8}-01`, `sdd-task-${id8}-02`]);
  assert.deepEqual(
    res.tasks.map((t) => t.id),
    ["t1", "t2"],
  );
  // Phase telemetry: one synthesis event per phase, even without a Run doc.
  assert.deepEqual(
    store.events.map((e) => (e.payload as { kind: string }).kind),
    ["spec", "design", "tasks"],
  );
});

test("trailing prose after the array (with stray brackets) does not break parsing", async () => {
  // Live failure mode (gemma-4 on LM Studio): valid array, then an explanation that
  // itself contains "]" — a greedy regex over-matches; the balanced extractor must not.
  const chatty = `${GOOD_TASKS}\n\nNote: dependsOn uses ids [t1] so t2 runs after t1.`;
  const { res } = await run(SPEC_PROMPT, new FakeProvider([chatty]));
  assert.equal(res.tasks.length, 2);
});

test("malformed tasks JSON is repaired with ONE retry", async () => {
  const provider = new FakeProvider(["this is not json at all", GOOD_TASKS]);
  const { res } = await run(SPEC_PROMPT, provider);
  assert.equal(res.tasks.length, 2);
});

test("two malformed answers fail loudly", async () => {
  const provider = new FakeProvider(["nope", "still nope"]);
  await assert.rejects(() => run(SPEC_PROMPT, provider), /could not parse the tasks JSON after one retry/);
});
