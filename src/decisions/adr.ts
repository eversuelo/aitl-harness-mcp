/**
 * ADR store — mirror Nygard-format ADRs from docs/adr/ into MongoDB.
 *
 * ADRs are the durable answer to Pain Point #1 (decision amnesia). They live as
 * markdown in git (human-readable, reviewable) AND in the `decisions` collection
 * (machine-retrievable via $vectorSearch alongside memory and chats).
 */

import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { ensureMongoose } from "../db/mongoose.js";
import { embedOne } from "../ingest/embedder.js";
import { type ADR, ADR_STATUSES, type AdrStatus, DecisionModel, makeADR } from "../models/decision.model.js";
import { currentBranch, headSha } from "../util/git.js";
import { ADR_CONTENT_FIELDS, type VersioningActor, archiveAndBumpVersion } from "../memory/versioning.js";

const ID_RE = /ADR-?(\d+)/i;
// `Status` is split out too (ADR-0027 style `## Status` sections) so it never leaks
// into `context`; the canonical form is the `- **Status:** …` metadata bullet.
const SECTION_RE = /^##\s+(Status|Context|Decision|Consequences)\s*$/gim;
// Metadata bullets in the header block, e.g. `- **Status:** accepted` / `- **Date:** 2026-06-13`.
const META_BULLET_RE = /^-\s*\*\*([A-Za-z][A-Za-z -]*?):?\*\*:?\s*(.+?)\s*$/gm;

/** Parse `YYYY-MM-DD` (or any Date.parse-able string) into a Date, or null. */
function parseDateMeta(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Normalize a status string ("Accepted", "accepted") to the enum, or null if unknown. */
function normalizeStatus(value: string | undefined): AdrStatus | null {
  const s = value?.trim().split(/\s+/)[0]?.toLowerCase();
  return s && (ADR_STATUSES as readonly string[]).includes(s) ? (s as AdrStatus) : null;
}

export async function parseAdrMarkdown(path: string, project: string): Promise<ADR> {
  const text = await fs.readFile(path, "utf-8");
  const firstLine = text.split(/\r?\n/).find((ln) => ln.trim()) ?? "";
  const m = ID_RE.exec(firstLine) ?? ID_RE.exec(basename(path));
  const adrId = m ? m[1] : basename(path, extname(path));
  // Strip only the `ADR-NNNN —` prefix so titles containing an em-dash survive round-trips.
  const title =
    firstLine.replace(/^#+\s*/, "").replace(/^ADR[-\s]?\d+\s*[—–-]\s*/i, "").trim() || firstLine.trim();

  // Split on the section headings: [pre, "Context", body, "Decision", body, ...].
  const parts = text.split(SECTION_RE);
  const sections: Record<string, string> = {};
  for (let i = 1; i < parts.length - 1; i += 2) {
    sections[parts[i].toLowerCase()] = parts[i + 1].trim();
  }

  // Lifecycle/provenance metadata from the header bullets (the block before the first `##`).
  const meta: Record<string, string> = {};
  for (const b of parts[0].matchAll(META_BULLET_RE)) {
    meta[b[1].toLowerCase().replace(/\s+/g, "-")] = b[2];
  }
  const status = normalizeStatus(meta.status) ?? normalizeStatus(sections.status) ?? "accepted";
  const createdAt = parseDateMeta(meta.date);
  const reviewAfter = parseDateMeta(meta["review-after"]);
  const components = meta.components
    ? meta.components.split(",").map((c) => c.trim()).filter(Boolean)
    : [];

  return await makeADR({
    project,
    id: adrId,
    title,
    context: sections.context ?? "",
    decision: sections.decision ?? "",
    consequences: sections.consequences ?? "",
    status,
    deprecation_reason: meta["deprecation-reason"] ?? null,
    superseded_by: meta["superseded-by"] ?? null,
    review_after: reviewAfter,
    components,
    ...(createdAt ? { created_at: createdAt } : {}),
    git_ref: path,
  });
}

export class ADRStore {
  /**
   * Insert/update ONE ADR, keyed by (project, id).
   *
   * Git provenance (F2) is resolved HERE so every surface (CLI, MCP, API) gets it for
   * free: when the caller does not pass `branch`/`commit_sha`, the current branch and
   * HEAD sha of the process cwd are stamped. Explicit values (including null) win.
   */
  async upsert(
    adr: ADR,
    opts: { embed?: boolean; actor?: VersioningActor; branch?: string | null; commit_sha?: string | null } = {},
  ): Promise<string> {
    await ensureMongoose();
    if (opts.embed !== false) {
      adr.embedding = await embedOne(`${adr.title}\n${adr.context}\n${adr.decision}`);
    }
    const branch = opts.branch !== undefined ? opts.branch : currentBranch();
    const commitSha = opts.commit_sha !== undefined ? opts.commit_sha : headSha();
    // Archive the prior version (if content changed) and set adr.version BEFORE overwrite.
    await archiveAndBumpVersion({
      kind: "decision",
      query: { project: adr.project, id: adr.id },
      nextDoc: adr,
      contentFields: ADR_CONTENT_FIELDS,
      ref: adr.id,
      actor: opts.actor,
      branch,
      commit_sha: commitSha,
    });
    await DecisionModel.updateOne({ project: adr.project, id: adr.id }, { $set: adr }, { upsert: true });
    return adr.id;
  }

  /** Mirror all docs/adr/NNNN-*.md into Mongo. Returns ADR ids written. */
  async syncDir(directory: string, project: string, opts: { actor?: VersioningActor; branch?: string | null; commit_sha?: string | null } = {}): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const mdFiles = entries
      // Only numbered ADR files (e.g. 0001-*.md); skip README/index and other notes.
      .filter((e) => e.isFile() && extname(e.name) === ".md" && /^\d{3,4}[-.]/.test(e.name))
      .map((e) => join(directory, e.name))
      .sort();
    const ids: string[] = [];
    for (const p of mdFiles) ids.push(await this.upsert(await parseAdrMarkdown(p, project), { actor: opts.actor, branch: opts.branch, commit_sha: opts.commit_sha }));
    return ids;
  }
}
