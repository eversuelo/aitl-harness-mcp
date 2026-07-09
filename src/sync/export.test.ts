import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAdrMarkdown } from "../decisions/adr.js";
import { makeADR } from "../models/decision.model.js";
import { makeDefinitionRecord } from "../models/definition.model.js";
import { makeMemoryDoc } from "../models/memory.model.js";
import {
  adrFileName,
  extractTaskJson,
  renderAdrMarkdown,
  renderDefinitionMarkdown,
  renderMemoryMarkdown,
  renderTaskMarkdown,
  sanitizeFileName,
  slugifyTitle,
  taskFilePath,
  writeIfChanged,
} from "./export.js";
import { parseDefinitionFile, parseMemoryFileForSync } from "./sync.js";

const tmpDir = () => fs.mkdtemp(join(tmpdir(), "aitl-export-"));

// ── memory round-trip ─────────────────────────────────────────────────────────

test("memory: export → parse round-trips every content field (provenance stripped from frontmatter)", async () => {
  const doc = await makeMemoryDoc({
    project: "p",
    slug: "note-a",
    description: "Has: colon and \"quotes\"",
    type: "reference",
    body: "Body with [[link-target]] and [[other]]\nsecond line\n",
    tags: ["alpha", "beta"],
    category: "reference",
    repo: "backend",
    version: 3,
    updated_at: new Date("2026-07-06T10:00:00.123Z"),
    branch: "feat/x",
    commit_sha: "deadbeef",
  });
  const rendered = renderMemoryMarkdown(doc);
  assert.ok(!rendered.includes("embedding"), "embedding never exported");

  const dir = await tmpDir();
  const path = join(dir, "note-a.md");
  await fs.writeFile(path, rendered, "utf-8");
  const parsed = await parseMemoryFileForSync(path, "p");

  assert.equal(parsed.slug, "note-a");
  assert.equal(parsed.description, doc.description);
  assert.equal(parsed.type, "reference");
  assert.equal(parsed.body, doc.body);
  assert.deepEqual([...(parsed.tags ?? [])], ["alpha", "beta"]);
  assert.equal(parsed.category, "reference");
  assert.equal(parsed.repo, "backend");
  assert.deepEqual([...(parsed.links ?? [])], ["link-target", "other"]);
  // Provenance keys must not survive into the stored frontmatter.
  const fm = parsed.frontmatter as Record<string, unknown>;
  for (const k of ["version", "updated_at", "branch", "commit_sha"]) {
    assert.ok(!(k in fm), `frontmatter must not keep provenance key '${k}'`);
  }
});

test("memory: render is deterministic (same doc → identical bytes) and writeIfChanged is a no-op on equal bytes", async () => {
  const doc = await makeMemoryDoc({
    project: "p",
    slug: "det",
    body: "stable body\n",
    updated_at: new Date("2026-07-06T10:00:00.000Z"),
  });
  const a = renderMemoryMarkdown(doc);
  const b = renderMemoryMarkdown(doc);
  assert.equal(a, b);

  const dir = await tmpDir();
  const path = join(dir, "det.md");
  assert.equal(await writeIfChanged(path, a), "written");
  const { mtimeMs } = await fs.stat(path);
  assert.equal(await writeIfChanged(path, b), "unchanged");
  assert.equal((await fs.stat(path)).mtimeMs, mtimeMs, "unchanged write must not touch the file");
});

// ── ADR round-trip ────────────────────────────────────────────────────────────

test("adr: export → parseAdrMarkdown round-trips content + lifecycle fields (status, reason, superseded_by, review_after, components)", async () => {
  const adr = await makeADR({
    project: "p",
    id: "0042",
    title: "Título con acentos — y un guión interior",
    context: "Multi-line context.\n\n- with a bullet\n- and `code`",
    decision: "The decision body.",
    consequences: "Consequence prose.",
    status: "deprecated",
    deprecation_reason: "replaced by the v2 pipeline",
    superseded_by: "0043",
    review_after: new Date("2027-01-01T00:00:00.000Z"),
    components: ["src/db", "src/sync"],
    created_at: new Date("2026-07-06T00:00:00.000Z"),
  });
  const rendered = renderAdrMarkdown(adr);
  assert.equal(rendered, renderAdrMarkdown(adr), "deterministic render");

  const dir = await tmpDir();
  const path = join(dir, adrFileName(adr));
  await fs.writeFile(path, rendered, "utf-8");
  const parsed = await parseAdrMarkdown(path, "p");

  assert.equal(parsed.id, "0042");
  assert.equal(parsed.title, adr.title); // interior em-dash survives
  assert.equal(parsed.context, adr.context);
  assert.equal(parsed.decision, adr.decision);
  assert.equal(parsed.consequences, adr.consequences);
  assert.equal(parsed.status, "deprecated");
  assert.equal(parsed.deprecation_reason, adr.deprecation_reason);
  assert.equal(parsed.superseded_by, "0043");
  assert.equal(parsed.review_after?.toISOString().slice(0, 10), "2027-01-01");
  assert.deepEqual([...(parsed.components ?? [])], ["src/db", "src/sync"]);
  assert.equal(parsed.created_at?.toISOString().slice(0, 10), "2026-07-06");
  // Canonical fixpoint: re-rendering the parsed doc reproduces the same bytes.
  assert.equal(renderAdrMarkdown(parsed), rendered);
});

test("adr: parses the handwritten docs/adr style (capitalized Status bullet, no blank line after headings)", async () => {
  const dir = await tmpDir();
  const path = join(dir, "0001-record-decisions.md");
  await fs.writeFile(
    path,
    "# ADR-0001 — Record architecture decisions\n\n" +
      "- **Status:** Accepted\n- **Date:** 2026-06-13\n\n" +
      "## Context\nProse without a leading blank line.\n\n" +
      "## Decision\nWe keep ADRs under docs/adr.\n\n" +
      "## Consequences\n- Decisions survive resets.\n",
    "utf-8",
  );
  const parsed = await parseAdrMarkdown(path, "p");
  assert.equal(parsed.id, "0001");
  assert.equal(parsed.title, "Record architecture decisions");
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.created_at?.toISOString().slice(0, 10), "2026-06-13");
  assert.equal(parsed.context, "Prose without a leading blank line.");
  assert.equal(parsed.consequences, "- Decisions survive resets.");
});

test("adr: parses the `## Status` section variant without leaking it into context", async () => {
  const dir = await tmpDir();
  const path = join(dir, "0027-versioning.md");
  await fs.writeFile(
    path,
    "# ADR-0027 — Versionamiento append-only\n\n## Status\n\nproposed\n\n## Context\n\nctx aquí\n\n## Decision\n\ndec\n\n## Consequences\n\ncons\n",
    "utf-8",
  );
  const parsed = await parseAdrMarkdown(path, "p");
  assert.equal(parsed.status, "proposed");
  assert.equal(parsed.context, "ctx aquí");
  assert.doesNotMatch(parsed.context, /proposed/);
});

// ── definitions round-trip ────────────────────────────────────────────────────

test("definition: export → parse round-trips name/description/tags/content and role metadata", async () => {
  const rec = await makeDefinitionRecord({
    project: "p",
    name: "security-reviewer",
    description: "Reviews changes for security issues.",
    content: "# Role\n\nAlways check authz paths.\n",
    tags: ["role", "review"],
    metadata: { kind: "role", seniority: "senior" },
    updated_at: new Date("2026-07-06T10:00:00.000Z"),
  });
  const rendered = renderDefinitionMarkdown(rec);
  assert.equal(rendered, renderDefinitionMarkdown(rec), "deterministic render");

  const dir = await tmpDir();
  const path = join(dir, "security-reviewer.md");
  await fs.writeFile(path, rendered, "utf-8");
  const parsed = await parseDefinitionFile(path, "p");

  assert.equal(parsed.name, "security-reviewer");
  assert.equal(parsed.description, rec.description);
  assert.equal(parsed.content, rec.content);
  assert.deepEqual(parsed.tags, ["role", "review"]);
  assert.deepEqual(parsed.metadata, { kind: "role", seniority: "senior" });
});

// ── file naming ───────────────────────────────────────────────────────────────

test("file naming: sanitize + ADR filename slugs are filesystem-safe and stable", () => {
  assert.equal(sanitizeFileName("nota/rara: sí?"), "nota-rara-s");
  assert.match(sanitizeFileName("a/b\\c:d"), /^[A-Za-z0-9._-]+$/);
  assert.equal(sanitizeFileName("../../etc/passwd"), "etc-passwd");
  assert.equal(slugifyTitle("Conexión única — Mongoose dueño (getDb sin autoconectar)"), "conexion-unica-mongoose-dueno-getdb-sin-autoconectar");
  assert.equal(adrFileName({ id: "0051", title: "Sync bidireccional markdown" }), "0051-sync-bidireccional-markdown.md");
});

// ── task export (ADR-0062) ────────────────────────────────────────────────────

test("tasks: renderTaskMarkdown lifts the SddTask JSON into the frontmatter", async () => {
  const taskJson = {
    id: "t2",
    title: "Cablear el endpoint",
    description: "…",
    dependsOn: ["t1"],
    files: ["src/api.ts"],
  };
  const body = [
    "# t2 — Cablear el endpoint",
    "",
    "…",
    "",
    "Depends on: t1",
    "Files: src/api.ts",
    "",
    "```json",
    JSON.stringify(taskJson, null, 2),
    "```",
  ].join("\n");
  const doc = await makeMemoryDoc({
    project: "p",
    slug: "sdd-task-abc12345-02",
    type: "task",
    category: "task",
    description: "SDD task t2: Cablear el endpoint",
    body,
    tags: ["sdd", "run:abc12345", "parent:sdd-design-abc12345"],
  });
  const rendered = renderTaskMarkdown(doc);
  assert.ok(!rendered.includes("embedding"));
  const { data, content } = (await import("gray-matter")).default(rendered);
  assert.equal(data.name, "sdd-task-abc12345-02");
  assert.equal(data.type, "task");
  assert.equal(data.task_id, "t2");
  assert.equal(data.title, "Cablear el endpoint");
  assert.deepEqual(data.depends_on, ["t1"]);
  assert.deepEqual(data.files, ["src/api.ts"]);
  assert.equal(content.trim(), body.trim(), "the body survives verbatim");
  assert.equal(rendered, renderTaskMarkdown(doc), "deterministic render");
});

test("tasks: a body without the JSON block still renders (no lifted fields)", async () => {
  const doc = await makeMemoryDoc({ project: "p", slug: "task-plain", type: "task", body: "solo prosa\n" });
  const rendered = renderTaskMarkdown(doc);
  const { data } = (await import("gray-matter")).default(rendered);
  assert.equal(data.task_id, undefined);
  assert.equal(data.type, "task");
});

test("tasks: extractTaskJson tolerates malformed JSON and missing blocks", () => {
  assert.equal(extractTaskJson(undefined), null);
  assert.equal(extractTaskJson("sin bloque"), null);
  assert.equal(extractTaskJson("```json\n{rotísimo\n```"), null);
  assert.deepEqual(extractTaskJson('```json\n{"id":"t1"}\n```'), { id: "t1" });
});

test("tasks: taskFilePath sanitizes the slug under <dir>/tasks/", () => {
  assert.equal(taskFilePath("/out", "sdd task/rara"), "/out/tasks/sdd-task-rara.md");
});
