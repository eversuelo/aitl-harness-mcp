/**
 * Mongo → markdown exporters (P4). Render durable entities into the canonical
 * on-disk mirror so they are git-reviewable and editable:
 *
 *   memory  → <dir>/memory/<slug>.md   (YAML frontmatter `parseMarkdownFile` understands)
 *   skills  → <dir>/skills/<name>.md
 *   agents  → <dir>/agents/<name>.md   (roles included: metadata.kind="role" survives in frontmatter)
 *   ADRs    → <adrDir>/NNNN-slug.md    (the Nygard format `parseAdrMarkdown` parses)
 *
 * Renderers are pure and deterministic: the same doc always yields the same bytes
 * (that is what makes the sync manifest's content hashes trustworthy). `embedding`
 * is never exported. Writes are incremental (byte-identical files are left alone);
 * for ADRs an existing file with DIFFERENT content is skipped by default — docs/adr
 * is handwritten territory, and only `aitl sync` (which has a manifest to know which
 * side changed) may overwrite there.
 */

import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import matter from "gray-matter";
import { ensureMongoose } from "../db/mongoose.js";
import { RESERVED_MEMORY_TYPES } from "../memory/schemas.js";
import { type ADR, DecisionModel } from "../models/decision.model.js";
import { type DefinitionKind, type DefinitionRecord, modelFor } from "../models/definition.model.js";
import { type MemoryDoc, MemoryModel } from "../models/memory.model.js";

// ── file naming ──────────────────────────────────────────────────────────────

/** Make a slug/name safe as a file basename (no path separators or exotic chars). */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return safe || "unnamed";
}

/** Kebab-case an ADR title for its filename (accents stripped, capped at 8 words). */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return slug || "adr";
}

export const adrFileName = (adr: Pick<ADR, "id" | "title">): string =>
  `${adr.id}-${slugifyTitle(adr.title)}.md`;

export const memoryFilePath = (dir: string, slug: string): string =>
  join(dir, "memory", `${sanitizeFileName(slug)}.md`);

export const definitionFilePath = (dir: string, kind: DefinitionKind, name: string): string =>
  join(dir, kind === "agent" ? "agents" : "skills", `${sanitizeFileName(name)}.md`);

export const taskFilePath = (dir: string, slug: string): string =>
  join(dir, "tasks", `${sanitizeFileName(slug)}.md`);

// ── renderers (pure, deterministic) ──────────────────────────────────────────

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** One memory doc → markdown with YAML frontmatter `parseMarkdownFile` round-trips. */
export function renderMemoryMarkdown(doc: MemoryDoc): string {
  const fm: Record<string, unknown> = { name: doc.slug };
  if (doc.description) fm.description = doc.description;
  fm.type = doc.type ?? "project";
  if (doc.category) fm.category = doc.category;
  if (doc.tags?.length) fm.tags = [...doc.tags];
  if (doc.repo) fm.repo = doc.repo;
  fm.version = doc.version ?? 1;
  if (doc.updated_at) fm.updated_at = doc.updated_at;
  if (doc.branch) fm.branch = doc.branch;
  if (doc.commit_sha) fm.commit_sha = doc.commit_sha;
  return matter.stringify(doc.body ?? "", fm);
}

/** One agent/skill definition → markdown (metadata kept, so roles survive round-trips). */
export function renderDefinitionMarkdown(rec: DefinitionRecord): string {
  const fm: Record<string, unknown> = { name: rec.name };
  if (rec.description) fm.description = rec.description;
  if (rec.tags?.length) fm.tags = [...rec.tags];
  const metadata = rec.metadata as Record<string, unknown> | undefined;
  if (metadata && Object.keys(metadata).length) fm.metadata = metadata;
  if (rec.updated_at) fm.updated_at = rec.updated_at;
  return matter.stringify(rec.content ?? "", fm);
}

/** Fields decomposeTasks embeds as a ```json block inside every task body. */
export interface TaskJsonFields {
  id?: string;
  title?: string;
  dependsOn?: string[];
  files?: string[];
}

/** Best-effort lift of the SddTask JSON block out of a task doc's body. */
export function extractTaskJson(body: string | undefined): TaskJsonFields | null {
  if (!body) return null;
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as unknown;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    return {
      ...(typeof r.id === "string" ? { id: r.id } : {}),
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      ...(Array.isArray(r.dependsOn) ? { dependsOn: r.dependsOn.map(String) } : {}),
      ...(Array.isArray(r.files) ? { files: r.files.map(String) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * One task memory doc → markdown. Same deterministic shape as memory, plus the
 * SddTask fields lifted into the frontmatter (task_id/title/depends_on/files) so a
 * task file is machine-readable without parsing the embedded JSON block.
 */
export function renderTaskMarkdown(doc: MemoryDoc): string {
  const fm: Record<string, unknown> = { name: doc.slug };
  if (doc.description) fm.description = doc.description;
  fm.type = "task";
  if (doc.category) fm.category = doc.category;
  if (doc.tags?.length) fm.tags = [...doc.tags];
  const t = extractTaskJson(doc.body);
  if (t?.id) fm.task_id = t.id;
  if (t?.title) fm.title = t.title;
  if (t?.dependsOn?.length) fm.depends_on = [...t.dependsOn];
  if (t?.files?.length) fm.files = [...t.files];
  if (doc.repo) fm.repo = doc.repo;
  fm.version = doc.version ?? 1;
  if (doc.updated_at) fm.updated_at = doc.updated_at;
  if (doc.branch) fm.branch = doc.branch;
  if (doc.commit_sha) fm.commit_sha = doc.commit_sha;
  return matter.stringify(doc.body ?? "", fm);
}

/** Single-line-ify a metadata bullet value so the header block stays parseable. */
const bulletValue = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

/**
 * One ADR → Nygard markdown in the exact shape `parseAdrMarkdown` reads back:
 * `# ADR-NNNN — Title`, metadata bullets (Status/Date + lifecycle fields), then
 * `## Context / ## Decision / ## Consequences`.
 */
export function renderAdrMarkdown(adr: ADR): string {
  const lines: string[] = [`# ADR-${adr.id} — ${adr.title}`, ""];
  lines.push(`- **Status:** ${adr.status ?? "accepted"}`);
  if (adr.created_at) lines.push(`- **Date:** ${isoDay(adr.created_at)}`);
  if (adr.deprecation_reason) lines.push(`- **Deprecation-reason:** ${bulletValue(adr.deprecation_reason)}`);
  if (adr.superseded_by) lines.push(`- **Superseded-by:** ${adr.superseded_by}`);
  if (adr.review_after) lines.push(`- **Review-after:** ${isoDay(adr.review_after)}`);
  if (adr.components?.length) lines.push(`- **Components:** ${adr.components.join(", ")}`);
  for (const [name, body] of [
    ["Context", adr.context],
    ["Decision", adr.decision],
    ["Consequences", adr.consequences],
  ] as const) {
    lines.push("", `## ${name}`);
    if (body?.trim()) lines.push("", body.trim());
  }
  return `${lines.join("\n")}\n`;
}

// ── Mongo loaders (embedding never leaves the DB) ────────────────────────────

/** A project's memory docs, reserved pipeline types excluded unless asked for. */
export async function loadMemoryDocs(
  project: string,
  opts: { includeReserved?: boolean } = {},
): Promise<MemoryDoc[]> {
  await ensureMongoose();
  const filter: Record<string, unknown> = { project };
  if (!opts.includeReserved) filter.type = { $nin: [...RESERVED_MEMORY_TYPES] };
  return MemoryModel.find(filter, { embedding: 0 }).sort({ slug: 1 }).lean() as unknown as Promise<MemoryDoc[]>;
}

/** A project's SDD tasks (memory `type:"task"`), optionally scoped to one run id8. */
export async function loadTaskDocs(project: string, opts: { run?: string } = {}): Promise<MemoryDoc[]> {
  await ensureMongoose();
  const filter: Record<string, unknown> = { project, type: "task" };
  if (opts.run) filter.tags = `run:${opts.run}`;
  return MemoryModel.find(filter, { embedding: 0 }).sort({ slug: 1 }).lean() as unknown as Promise<MemoryDoc[]>;
}

/** A project's agent/skill definitions (roles live in `agents` with metadata.kind="role"). */
export async function loadDefinitions(kind: DefinitionKind, project: string): Promise<DefinitionRecord[]> {
  await ensureMongoose();
  return modelFor(kind).find({ project }).sort({ name: 1 }).lean() as unknown as Promise<DefinitionRecord[]>;
}

/** A project's ADRs, ordered by id. */
export async function loadAdrs(project: string): Promise<ADR[]> {
  await ensureMongoose();
  return DecisionModel.find({ project }, { embedding: 0 }).sort({ id: 1 }).lean() as unknown as Promise<ADR[]>;
}

// ── disk helpers ─────────────────────────────────────────────────────────────

export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Write only when the bytes differ (keeps mtimes/git status quiet on no-ops). */
export async function writeIfChanged(path: string, content: string): Promise<"written" | "unchanged"> {
  if ((await readFileOrNull(path)) === content) return "unchanged";
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf-8");
  return "written";
}

const ADR_FILE_RE = /^(\d{3,4})[-.]/;

/**
 * Map ADR id → ALL file paths carrying that numeric prefix (bytewise-sorted).
 * More than one path for an id is ambiguous — callers must skip it, never guess.
 */
export async function scanAdrDir(adrDir: string): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(adrDir, { withFileTypes: true });
  } catch {
    return byId;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isFile() || extname(e.name) !== ".md") continue;
    const m = ADR_FILE_RE.exec(e.name);
    if (m) byId.set(m[1], [...(byId.get(m[1]) ?? []), join(adrDir, e.name)]);
  }
  return byId;
}

/** Canonical ADR ids are purely numeric ("0001"); anything else is legacy junk. */
export const ADR_ID_RE = /^\d{3,4}$/;

/** List `*.md` files directly under a directory (missing dir → empty). */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && extname(e.name) === ".md")
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

// ── one-shot exporters (manifest-less; used by `aitl export --adapter markdown`) ──

export interface ExportResult {
  written: string[];
  unchanged: string[];
  /** Existing files whose content differs — never clobbered by a one-shot export. */
  skipped: { path: string; reason: string }[];
}

const emptyResult = (): ExportResult => ({ written: [], unchanged: [], skipped: [] });

async function exportRendered(files: { path: string; content: string }[]): Promise<ExportResult> {
  const res = emptyResult();
  for (const f of files) {
    (await writeIfChanged(f.path, f.content)) === "written" ? res.written.push(f.path) : res.unchanged.push(f.path);
  }
  return res;
}

/** Export a project's memory bank to `<dir>/memory/<slug>.md`. */
export async function exportMemory(
  project: string,
  dir: string,
  opts: { includeReserved?: boolean } = {},
): Promise<ExportResult> {
  const docs = await loadMemoryDocs(project, opts);
  return exportRendered(
    docs.map((d) => ({ path: memoryFilePath(dir, d.slug), content: renderMemoryMarkdown(d) })),
  );
}

/** Export a project's skills to `<dir>/skills/<name>.md`. */
export async function exportSkills(project: string, dir: string): Promise<ExportResult> {
  const recs = await loadDefinitions("skill", project);
  return exportRendered(
    recs.map((r) => ({ path: definitionFilePath(dir, "skill", r.name), content: renderDefinitionMarkdown(r) })),
  );
}

/** Export a project's agents (roles included) to `<dir>/agents/<name>.md`. */
export async function exportAgents(project: string, dir: string): Promise<ExportResult> {
  const recs = await loadDefinitions("agent", project);
  return exportRendered(
    recs.map((r) => ({ path: definitionFilePath(dir, "agent", r.name), content: renderDefinitionMarkdown(r) })),
  );
}

/**
 * Export a project's SDD tasks to `<dir>/tasks/<slug>.md` (ADR-0062: "export to
 * dir" — materialize the task docs as reviewable markdown wherever asked).
 */
export async function exportTasks(
  project: string,
  dir: string,
  opts: { run?: string } = {},
): Promise<ExportResult> {
  const docs = await loadTaskDocs(project, opts);
  return exportRendered(
    docs.map((d) => ({ path: taskFilePath(dir, d.slug), content: renderTaskMarkdown(d) })),
  );
}

/**
 * Export a project's ADRs to `<adrDir>/NNNN-slug.md`. Additive-safe: an existing
 * file for the same id that differs byte-wise is SKIPPED (handwritten prose must
 * not be flattened by a manifest-less export — use `aitl sync` to reconcile).
 */
export async function exportAdrs(project: string, adrDir: string): Promise<ExportResult> {
  const adrs = await loadAdrs(project);
  const existing = await scanAdrDir(adrDir);
  const res = emptyResult();
  for (const adr of adrs) {
    if (!ADR_ID_RE.test(adr.id)) {
      res.skipped.push({ path: adr.id, reason: "non-numeric ADR id (legacy Mongo doc) — not mirrored" });
      continue;
    }
    const paths = existing.get(adr.id) ?? [];
    if (paths.length > 1) {
      res.skipped.push({ path: paths.join(", "), reason: `ambiguous: ${paths.length} files share the ${adr.id} prefix` });
      continue;
    }
    const path = paths[0] ?? join(adrDir, adrFileName(adr));
    const content = renderAdrMarkdown(adr);
    const current = await readFileOrNull(path);
    if (current === content) res.unchanged.push(path);
    else if (current !== null) res.skipped.push({ path, reason: "exists with different content (kept; reconcile with `aitl sync`)" });
    else {
      await writeIfChanged(path, content);
      res.written.push(path);
    }
  }
  return res;
}

/** Convenience: memory slug or definition name read from a mirror file's frontmatter. */
export function frontmatterName(raw: string, path: string): string {
  try {
    const { data } = matter(raw);
    if (typeof data.name === "string" && data.name) return data.name;
  } catch {
    // fall through to the filename
  }
  return basename(path, extname(path));
}
