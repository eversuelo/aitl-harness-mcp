/**
 * Zod schemas for every document stored in MongoDB.
 *
 * These are the durable, structured artifacts that replace markdown-probabilistic
 * state. Every collection has a schema here; `src/memory/store.ts` (de)serializes them.
 * Use the `make*` builders — they fill the shared defaults (project, timestamps).
 */

import { z } from "zod";

const now = () => new Date();

export const MEMORY_TYPES = ["user", "feedback", "project", "reference", "synthesis"] as const;
export const ROLES = ["user", "assistant", "tool", "system"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Role = (typeof ROLES)[number];

// ── shared base fields ───────────────────────────────────────────────────
const BaseShape = {
  project: z.string(), // Project scope; isolates multi-project memory.
  created_at: z.date().default(now),
  updated_at: z.date().default(now),
};

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  input: z.record(z.unknown()).default({}),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

// ── Run: one agent run / session ───────────────────────────────────────────
export const RunSchema = z.object({
  ...BaseShape,
  model: z.string(),
  harness_config: z.record(z.unknown()).default({}),
  status: z.enum(["running", "done", "error"]).default("running"),
  token_usage: z.object({ input: z.number(), output: z.number() }).default({ input: 0, output: 0 }),
  started_at: z.date().default(now),
  ended_at: z.date().nullable().default(null),
  tags: z.array(z.string()).default([]),
});
export type Run = z.infer<typeof RunSchema>;

// ── Message: one transcript turn (chat) ─────────────────────────────────────
export const MessageSchema = z.object({
  ...BaseShape,
  run_id: z.string(),
  idx: z.number().int(),
  role: z.enum(ROLES),
  content: z.string(),
  tool_calls: z.array(ToolCallSchema).default([]),
  tool_call_id: z.string().nullable().default(null), // links a tool result to its call (resume)
  tokens: z.number().int().default(0),
  category: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  embedding: z.array(z.number()).nullable().default(null),
});
export type Message = z.infer<typeof MessageSchema>;

// ── MemoryDoc: a markdown memory file or a shared-bank entry ─────────────────
export const MemoryDocSchema = z.object({
  ...BaseShape,
  slug: z.string(),
  repo: z.string().nullable().default(null), // repo sub-scope within the project (ADR-0028)
  type: z.enum(MEMORY_TYPES).default("project"),
  description: z.string().default(""),
  body: z.string().default(""),
  frontmatter: z.record(z.unknown()).default({}),
  links: z.array(z.string()).default([]), // [[other-slug]] references
  source_path: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  version: z.number().int().default(1), // bumped on each content change; history in memory_history
  actor_id: z.string().nullable().default(null), // who authored the current version (provenance)
  actor_role: z.string().nullable().default(null),
  branch: z.string().nullable().default(null), // git branch this version was authored on (ADR-0028)
  embedding: z.array(z.number()).nullable().default(null),
});
export type MemoryDoc = z.infer<typeof MemoryDocSchema>;

// ── ADR: Architecture Decision Record (Nygard format) ───────────────────────
export const ADRSchema = z.object({
  ...BaseShape,
  id: z.string(), // e.g. "0001"
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  consequences: z.string(),
  status: z.enum(["proposed", "accepted", "superseded"]).default("accepted"),
  model: z.string().nullable().default(null),
  trigger: z.string().nullable().default(null),
  git_ref: z.string().nullable().default(null),
  version: z.number().int().default(1), // bumped on each content change; history in decisions_history
  actor_id: z.string().nullable().default(null), // who authored the current version (provenance)
  actor_role: z.string().nullable().default(null),
  branch: z.string().nullable().default(null), // git branch this version was authored on (ADR-0028)
  embedding: z.array(z.number()).nullable().default(null),
});
export type ADR = z.infer<typeof ADRSchema>;

// ── HistoryEntry: an archived prior version of an ADR or memory doc ──────────
// Append-only revision history. Before a live (decisions/memory) doc is overwritten
// with changed content, the previous doc is snapshotted here (embedding stripped).
export const HistoryEntrySchema = z.object({
  ...BaseShape,
  kind: z.enum(["decision", "memory"]),
  ref: z.string(), // the ADR id ("0007") or memory slug
  version: z.number().int(), // the version number of the archived snapshot
  actor_id: z.string().default("system"),
  actor_role: z.string().default("system"),
  branch: z.string().nullable().default(null), // git branch the archived version was authored on
  snapshot: z.record(z.unknown()), // the prior doc, without its embedding
  archived_at: z.date().default(now),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// ── Symbol: a repo-map symbol with its PageRank importance ───────────────────
export const SymbolSchema = z.object({
  ...BaseShape,
  repo: z.string().nullable().default(null), // repo sub-scope within the project (ADR-0028)
  file: z.string(),
  name: z.string(),
  kind: z.string(),
  refs: z.array(z.string()).default([]),
  pagerank: z.number().default(0),
  mtime: z.number().default(0),
});
export type Symbol = z.infer<typeof SymbolSchema>;

// ── Convention: a parsed convention/pattern rule ─────────────────────────────
export const ConventionSchema = z.object({
  ...BaseShape,
  scope_glob: z.string().default("**/*"),
  rule: z.string().default(""),
  severity: z.enum(["info", "warn", "error"]).default("warn"),
});
export type Convention = z.infer<typeof ConventionSchema>;

// ── Category: per-project classification taxonomy node ───────────────────────
export const CategorySchema = z.object({
  ...BaseShape,
  name: z.string(),
  kind: z.enum(["memory", "chat"]),
  description: z.string().default(""),
  rules: z.record(z.unknown()).default({}),
});
export type Category = z.infer<typeof CategorySchema>;

// ── Event: loop / harness event, for thesis analysis ─────────────────────────
export const EventSchema = z.object({
  ...BaseShape,
  run_id: z.string().nullable().default(null),
  type: z.enum(["loop_iter", "compaction", "tool_call", "gate", "synthesis", "hydrate", "session_summary", "skills_route", "retry", "verify", "error", "resume", "spawn"]),
  payload: z.record(z.unknown()).default({}),
  ts: z.date().default(now),
});
export type Event = z.infer<typeof EventSchema>;

// ── builders (mirror pydantic constructors: parse fills defaults) ────────────
export const makeRun = (v: z.input<typeof RunSchema>): Run => RunSchema.parse(v);
export const makeMessage = (v: z.input<typeof MessageSchema>): Message => MessageSchema.parse(v);
export const makeMemoryDoc = (v: z.input<typeof MemoryDocSchema>): MemoryDoc => MemoryDocSchema.parse(v);
export const makeADR = (v: z.input<typeof ADRSchema>): ADR => ADRSchema.parse(v);
export const makeHistoryEntry = (v: z.input<typeof HistoryEntrySchema>): HistoryEntry => HistoryEntrySchema.parse(v);
export const makeSymbol = (v: z.input<typeof SymbolSchema>): Symbol => SymbolSchema.parse(v);
export const makeConvention = (v: z.input<typeof ConventionSchema>): Convention => ConventionSchema.parse(v);
export const makeEvent = (v: z.input<typeof EventSchema>): Event => EventSchema.parse(v);
