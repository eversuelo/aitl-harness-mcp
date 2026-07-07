/**
 * Bidirectional markdown sync (P4): Mongo ⇄ the on-disk mirror.
 *
 *   memory/skills/agents ⇄ .aitl/{memory,skills,agents}/<slug>.md
 *   ADRs                 ⇄ docs/adr/NNNN-slug.md
 *
 * Three-way diff per entry against the `.aitl/.sync-state.json` manifest (state.ts):
 *   - changed only in Mongo  → write the canonical render to disk (pull)
 *   - changed only on disk   → parse + upsert into Mongo (push; versioning applies)
 *   - changed on BOTH sides  → conflict: touch nothing, report (unless --pull/--push
 *     forces a winner)
 *   - new on one side        → propagated to the other (no conflict)
 *
 * Bootstrap policy (no manifest entry yet, entity exists on BOTH sides with different
 * bytes): NOTHING is written — the current state of each side is adopted as the
 * baseline. This is what lets the first run repopulate only the MISSING docs/adr
 * files while leaving the handwritten ones (whose prose differs from the canonical
 * render only by formatting) byte-for-byte intact, even under --pull.
 *
 * Deletions are never propagated: a doc deleted in Mongo keeps its file (reported);
 * a deleted file is restored from Mongo on pull/both (the disk is a mirror).
 */

import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import matter from "gray-matter";
import { ADRStore, parseAdrMarkdown } from "../decisions/adr.js";
import { embedOne } from "../ingest/embedder.js";
import { parseMarkdownFile } from "../ingest/markdown.js";
import { Classifier } from "../memory/classifier.js";
import { RESERVED_MEMORY_TYPES } from "../memory/schemas.js";
import { MemoryStore } from "../memory/store.js";
import type { VersioningActor } from "../memory/versioning.js";
import type { ADR } from "../models/decision.model.js";
import type { DefinitionKind, DefinitionRecord } from "../models/definition.model.js";
import type { MemoryDoc } from "../models/memory.model.js";
import { DefinitionStore } from "../projectctx/store.js";
import { currentBranch, headSha } from "../util/git.js";
import {
  ADR_ID_RE,
  adrFileName,
  definitionFilePath,
  listMarkdownFiles,
  loadAdrs,
  loadDefinitions,
  loadMemoryDocs,
  memoryFilePath,
  renderAdrMarkdown,
  renderDefinitionMarkdown,
  renderMemoryMarkdown,
  scanAdrDir,
  writeIfChanged,
} from "./export.js";
import {
  type SyncEntity,
  type SyncEntry,
  diffEntry,
  entryId,
  loadSyncState,
  saveSyncState,
  sha256,
  stateFilePath,
  stateMap,
} from "./state.js";

export type SyncMode = "pull" | "push" | "both";

export interface SyncItem {
  entity: SyncEntity;
  key: string;
  path?: string;
  reason?: string;
}

export interface SyncResult {
  project: string;
  mode: SyncMode;
  pulled: SyncItem[];
  pushed: SyncItem[];
  conflicts: SyncItem[];
  skipped: SyncItem[];
  /** Entries already in sync (no-ops). */
  unchanged: number;
  statePath: string;
}

interface WriteOpts {
  actor?: VersioningActor;
  branch?: string | null;
  commit_sha?: string | null;
}

/** Store surface the engine needs — injectable so tests run on in-memory fakes. */
export interface SyncStores {
  listMemory(project: string, includeReserved: boolean): Promise<MemoryDoc[]>;
  /** Upsert and return the post-write doc (version/updated_at/provenance stamped). */
  upsertMemory(doc: MemoryDoc, opts: WriteOpts): Promise<MemoryDoc>;
  listDefinitions(kind: DefinitionKind, project: string): Promise<DefinitionRecord[]>;
  upsertDefinition(
    kind: DefinitionKind,
    rec: Partial<DefinitionRecord> & { project: string; name: string },
  ): Promise<DefinitionRecord>;
  listAdrs(project: string): Promise<ADR[]>;
  /** Upsert and return the post-write ADR (version stamped). */
  upsertAdr(adr: ADR, opts: WriteOpts): Promise<ADR>;
}

/** Real stores: same pipeline as `aitl ingest` / `adr-sync` (classify → embed → upsert). */
export function defaultSyncStores(): SyncStores {
  return {
    listMemory: (project, includeReserved) => loadMemoryDocs(project, { includeReserved }),
    async upsertMemory(doc, opts) {
      if (!doc.category) await new Classifier().classifyMemory(doc);
      doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
      await new MemoryStore().upsertMemory(doc, opts);
      return doc;
    },
    listDefinitions: (kind, project) => loadDefinitions(kind, project),
    upsertDefinition: (kind, rec) => new DefinitionStore(kind).upsert(rec),
    listAdrs: (project) => loadAdrs(project),
    async upsertAdr(adr, opts) {
      await new ADRStore().upsert(adr, opts);
      return adr;
    },
  };
}

// ── disk → doc parsers (sync flavor) ─────────────────────────────────────────

/** Frontmatter keys the exporter stamps for provenance — never round-tripped into Mongo. */
const PROVENANCE_KEYS = new Set([
  "version",
  "updated_at",
  "created_at",
  "branch",
  "commit_sha",
  "actor_id",
  "actor_role",
]);

/**
 * `parseMarkdownFile` + sync fidelity: lift tags/category/repo from the frontmatter
 * into the doc fields (the ingest parser leaves them in `frontmatter` only) and strip
 * the exporter's provenance keys so they don't pollute the stored frontmatter.
 */
export async function parseMemoryFileForSync(path: string, project: string): Promise<MemoryDoc> {
  const doc = await parseMarkdownFile(path, project);
  const fm = (doc.frontmatter ?? {}) as Record<string, unknown>;
  if (Array.isArray(fm.tags)) doc.tags = fm.tags.map(String);
  if (typeof fm.category === "string" && fm.category) doc.category = fm.category;
  if (typeof fm.repo === "string" && fm.repo) doc.repo = fm.repo;
  doc.frontmatter = Object.fromEntries(Object.entries(fm).filter(([k]) => !PROVENANCE_KEYS.has(k)));
  return doc;
}

/** Parse a `.aitl/{skills,agents}` mirror file into a DefinitionRecord shape. */
export async function parseDefinitionFile(
  path: string,
  project: string,
): Promise<Partial<DefinitionRecord> & { project: string; name: string }> {
  const raw = await fs.readFile(path, "utf-8");
  const { data, content } = matter(raw);
  const metadata = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : {};
  return {
    project,
    name: typeof data.name === "string" && data.name ? data.name : basename(path, extname(path)),
    description: typeof data.description === "string" ? data.description : "",
    content,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    metadata,
    source: path,
  };
}

// ── entity plans ─────────────────────────────────────────────────────────────

interface MongoSide {
  render: string;
  version: number | null;
  updatedAt: string | null;
}

interface DiskSide {
  path: string;
  raw: string;
}

interface EntityPlan {
  entity: SyncEntity;
  mongo: Map<string, MongoSide>;
  disk: Map<string, DiskSide>;
  /** Docs excluded at plan time (e.g. malformed legacy ADR ids) — reported as skipped. */
  preSkipped?: SyncItem[];
  /** Where a pull writes a key that has no file yet. */
  defaultPathFor(key: string): string;
  /** Parse + upsert one disk entry; returns the post-write Mongo side. */
  push(key: string, side: DiskSide): Promise<MongoSide>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function frontmatterData(raw: string): Record<string, unknown> {
  try {
    return matter(raw).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function buildMemoryPlan(
  project: string,
  dir: string,
  includeReserved: boolean,
  stores: SyncStores,
  writeOpts: WriteOpts,
): Promise<EntityPlan> {
  const mongo = new Map<string, MongoSide>();
  for (const doc of await stores.listMemory(project, includeReserved)) {
    if (!includeReserved && RESERVED_MEMORY_TYPES.has(doc.type ?? "")) continue; // defensive vs fakes
    mongo.set(doc.slug, { render: renderMemoryMarkdown(doc), version: doc.version ?? 1, updatedAt: iso(doc.updated_at) });
  }
  const disk = new Map<string, DiskSide>();
  for (const path of await listMarkdownFiles(join(dir, "memory"))) {
    const raw = await fs.readFile(path, "utf-8");
    const data = frontmatterData(raw);
    const fmType = (data.metadata as { type?: string } | undefined)?.type ?? data.type;
    if (!includeReserved && typeof fmType === "string" && RESERVED_MEMORY_TYPES.has(fmType)) continue;
    const key = typeof data.name === "string" && data.name ? data.name : basename(path, extname(path));
    disk.set(key, { path, raw });
  }
  return {
    entity: "memory",
    mongo,
    disk,
    defaultPathFor: (key) => memoryFilePath(dir, key),
    async push(key, side) {
      const doc = await parseMemoryFileForSync(side.path, project);
      doc.slug = key; // the manifest key (frontmatter name) is authoritative
      const saved = await stores.upsertMemory(doc, writeOpts);
      return { render: renderMemoryMarkdown(saved), version: saved.version ?? 1, updatedAt: iso(saved.updated_at) };
    },
  };
}

async function buildDefinitionPlan(
  kind: DefinitionKind,
  project: string,
  dir: string,
  stores: SyncStores,
): Promise<EntityPlan> {
  const entity: SyncEntity = kind === "agent" ? "agent" : "skill";
  const mongo = new Map<string, MongoSide>();
  for (const rec of await stores.listDefinitions(kind, project)) {
    mongo.set(rec.name, { render: renderDefinitionMarkdown(rec), version: null, updatedAt: iso(rec.updated_at) });
  }
  const disk = new Map<string, DiskSide>();
  for (const path of await listMarkdownFiles(join(dir, kind === "agent" ? "agents" : "skills"))) {
    const raw = await fs.readFile(path, "utf-8");
    const data = frontmatterData(raw);
    const key = typeof data.name === "string" && data.name ? data.name : basename(path, extname(path));
    disk.set(key, { path, raw });
  }
  return {
    entity,
    mongo,
    disk,
    defaultPathFor: (key) => definitionFilePath(dir, kind, key),
    async push(key, side) {
      const rec = await parseDefinitionFile(side.path, project);
      rec.name = key;
      const saved = await stores.upsertDefinition(kind, rec);
      return { render: renderDefinitionMarkdown(saved), version: null, updatedAt: iso(saved.updated_at) };
    },
  };
}

const DATE_BULLET_RE = /^-\s*\*\*Date:?\*\*/im;

async function buildAdrPlan(
  project: string,
  adrDir: string,
  stores: SyncStores,
  writeOpts: WriteOpts,
): Promise<EntityPlan> {
  const all = await stores.listAdrs(project);
  // Non-numeric ids (e.g. "0036-mongoose-data-layer", written by a pre-P4 adr-sync bug)
  // would collide with the real NNNN doc on disk — never mirrored, only reported.
  const adrs = all.filter((a) => ADR_ID_RE.test(a.id));
  const preSkipped: SyncItem[] = all
    .filter((a) => !ADR_ID_RE.test(a.id))
    .map((a) => ({ entity: "adr" as const, key: a.id, reason: "id de ADR no numérico (doc legado en Mongo) — no se espeja" }));
  const byId = new Map(adrs.map((a) => [a.id, a]));
  const mongo = new Map<string, MongoSide>();
  for (const adr of adrs) {
    mongo.set(adr.id, { render: renderAdrMarkdown(adr), version: adr.version ?? 1, updatedAt: iso(adr.updated_at) });
  }
  const disk = new Map<string, DiskSide>();
  for (const [id, paths] of await scanAdrDir(adrDir)) {
    if (paths.length > 1) {
      // Two files share the NNNN prefix: guessing could push the wrong bytes into a
      // real ADR — freeze the id entirely (no pull, no push) and report it.
      preSkipped.push({ entity: "adr", key: id, path: paths.join(", "), reason: "ambiguo: varios archivos comparten el prefijo — resuélvelo a mano" });
      mongo.delete(id);
      continue;
    }
    disk.set(id, { path: paths[0], raw: await fs.readFile(paths[0], "utf-8") });
  }
  return {
    entity: "adr",
    mongo,
    disk,
    preSkipped,
    defaultPathFor: (key) => {
      const adr = byId.get(key);
      return join(adrDir, adr ? adrFileName(adr) : `${key}.md`);
    },
    async push(key, side) {
      const adr = await parseAdrMarkdown(side.path, project);
      adr.id = key; // the filename-derived manifest key is authoritative
      // Files without a `- **Date:**` bullet must not churn created_at on every push.
      const prior = byId.get(key);
      if (prior?.created_at && !DATE_BULLET_RE.test(side.raw)) adr.created_at = prior.created_at;
      const saved = await stores.upsertAdr(adr, writeOpts);
      return { render: renderAdrMarkdown(saved), version: saved.version ?? 1, updatedAt: iso(saved.updated_at) };
    },
  };
}

// ── the sync engine ──────────────────────────────────────────────────────────

async function syncEntityPlan(
  plan: EntityPlan,
  mode: SyncMode,
  entries: Map<string, SyncEntry>,
  result: SyncResult,
  now: string,
): Promise<void> {
  if (plan.preSkipped?.length) result.skipped.push(...plan.preSkipped);
  const keys = new Set<string>([...plan.mongo.keys(), ...plan.disk.keys()]);
  for (const e of entries.values()) if (e.entity === plan.entity) keys.add(e.key);

  for (const key of [...keys].sort()) {
    const id = entryId(plan.entity, key);
    const mongo = plan.mongo.get(key) ?? null;
    const disk = plan.disk.get(key) ?? null;
    const entry = entries.get(id);
    const diskHash = disk ? sha256(disk.raw) : null;
    const mongoHash = mongo ? sha256(mongo.render) : null;

    if (!mongo && !disk) {
      entries.delete(id); // gone from both sides → prune the baseline
      continue;
    }

    const record = (side: MongoSide, dHash: string, path: string) =>
      entries.set(id, {
        entity: plan.entity,
        key,
        path,
        diskHash: dHash,
        mongoHash: sha256(side.render),
        mongoVersion: side.version,
        updatedAt: side.updatedAt,
        syncedAt: now,
      });

    const doPull = async (reason?: string) => {
      const path = disk?.path ?? entry?.path ?? plan.defaultPathFor(key);
      if (!mongo) throw new Error(`sync: pull without a Mongo side (${id})`);
      await writeIfChanged(path, mongo.render);
      record(mongo, sha256(mongo.render), path);
      result.pulled.push({ entity: plan.entity, key, path, reason });
    };
    const doPush = async (reason?: string) => {
      if (!disk || diskHash === null) throw new Error(`sync: push without a disk side (${id})`);
      const side = await plan.push(key, disk);
      record(side, diskHash, disk.path);
      result.pushed.push({ entity: plan.entity, key, path: disk.path, reason });
    };
    const skip = (reason: string) =>
      result.skipped.push({ entity: plan.entity, key, path: disk?.path ?? entry?.path, reason });

    // ── bootstrap: no baseline yet ──
    if (!entry) {
      if (mongo && disk && diskHash !== null) {
        record(mongo, diskHash, disk.path);
        if (diskHash === sha256(mongo.render)) result.unchanged++;
        else skip("bootstrap: existe en ambos lados con contenido distinto — baseline sembrada, nada se escribió");
      } else if (mongo) {
        if (mode === "push") skip("solo en Mongo (modo --push no escribe a disco)");
        else await doPull("nuevo en Mongo");
      } else if (disk) {
        if (mode === "pull") skip("solo en disco (modo --pull no escribe a Mongo)");
        else await doPush("nuevo en disco");
      }
      continue;
    }

    const { diskChanged, mongoChanged } = diffEntry(entry, diskHash, mongoHash);

    if (!diskChanged && !mongoChanged) {
      result.unchanged++;
      continue;
    }

    if (mongoChanged && !diskChanged) {
      if (!mongo) {
        skip("borrado en Mongo — el archivo se conserva (bórralo a mano o edítalo y --push para recrearlo)");
        continue;
      }
      if (mode === "push") {
        skip("cambió en Mongo (corre sin --push, o --pull)");
        continue;
      }
      await doPull();
      continue;
    }

    if (diskChanged && !mongoChanged) {
      if (!disk) {
        // Deleted file, Mongo intact: the disk is a mirror → restore (never delete Mongo).
        if (mode === "push") {
          skip("archivo borrado — el borrado no se propaga a Mongo");
          continue;
        }
        await doPull("archivo restaurado desde Mongo");
        continue;
      }
      if (mode === "pull") {
        skip("cambió en disco (corre sin --pull, o --push)");
        continue;
      }
      await doPush();
      continue;
    }

    // Both sides changed since the baseline.
    if (mode === "both") {
      result.conflicts.push({
        entity: plan.entity,
        key,
        path: disk?.path ?? entry.path,
        reason: "cambió en Mongo Y en disco — resuelve con --pull (gana Mongo) o --push (gana disco)",
      });
      continue;
    }
    if (mode === "pull") {
      if (!mongo) skip("conflicto: borrado en Mongo — el archivo se conserva");
      else await doPull("conflicto: gana Mongo");
      continue;
    }
    if (!disk) skip("conflicto: archivo borrado — el borrado no se propaga a Mongo");
    else await doPush("conflicto: gana disco");
  }
}

export interface SyncProjectOptions {
  /** Mirror root for memory/skills/agents (default ".aitl"; also hosts the manifest). */
  dir?: string;
  /** ADR mirror directory (default "docs/adr"). */
  adrDir?: string;
  mode?: SyncMode;
  includeReserved?: boolean;
  actor?: VersioningActor;
  /** Git provenance for pushes; defaults to the cwd's branch/HEAD. Explicit null wins. */
  branch?: string | null;
  commit_sha?: string | null;
  /** Injectable store surface (tests). */
  stores?: SyncStores;
}

/** Run the bidirectional sync for one project. Updates the manifest after every op. */
export async function syncProject(project: string, opts: SyncProjectOptions = {}): Promise<SyncResult> {
  const dir = opts.dir ?? ".aitl";
  const adrDir = opts.adrDir ?? join("docs", "adr");
  const mode = opts.mode ?? "both";
  const includeReserved = opts.includeReserved ?? false;
  const stores = opts.stores ?? defaultSyncStores();
  const writeOpts: WriteOpts = {
    actor: opts.actor,
    branch: opts.branch !== undefined ? opts.branch : currentBranch(),
    commit_sha: opts.commit_sha !== undefined ? opts.commit_sha : headSha(),
  };

  const entries = stateMap(await loadSyncState(dir));
  const now = new Date().toISOString();
  const result: SyncResult = {
    project,
    mode,
    pulled: [],
    pushed: [],
    conflicts: [],
    skipped: [],
    unchanged: 0,
    statePath: stateFilePath(dir),
  };

  const plans: EntityPlan[] = [
    await buildMemoryPlan(project, dir, includeReserved, stores, writeOpts),
    await buildDefinitionPlan("skill", project, dir, stores),
    await buildDefinitionPlan("agent", project, dir, stores),
    await buildAdrPlan(project, adrDir, stores, writeOpts),
  ];
  for (const plan of plans) await syncEntityPlan(plan, mode, entries, result, now);

  await saveSyncState(dir, { version: 1, entries: [...entries.values()] });
  return result;
}
