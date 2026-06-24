/**
 * Shared contracts — the canonical vocabulary both AITL-Harness projects implement.
 *
 * This is the TypeScript side of the cross-project parity contract
 * (`docs/parity-contract.json`). The Python port mirrors it in `aitl/contracts.py`.
 *
 * It does two things:
 *   1. Re-exports the durable document schemas under their canonical names
 *      (`DecisionDoc` = ADR, `SymbolDoc` = Symbol, `LoopEvent` = Event) so both
 *      ecosystems use the same names without breaking existing data/imports.
 *   2. Defines the structural *ports* the core depends on (ProviderPort, ToolPort,
 *      MemoryPort, LoopStrategy) plus small value types (ToolCall, GateResult, MetricRecord).
 *
 * Rule: the core (loop, context, memory) depends only on these ports — never on a
 * concrete provider/tool/DB SDK.
 */

import { z } from "zod";

// ── 1. canonical aliases for the durable document schemas ────────────────────
import {
  ADRSchema as DecisionDocSchema,
  EventSchema as LoopEventSchema,
  ToolCallSchema,
} from "./memory/schemas.js";
import type {
  ADR as DecisionDoc,
  Category,
  Convention,
  Event as LoopEvent,
  MemoryDoc,
  Message,
  Run,
  Symbol as SymbolDoc,
  ToolCall,
} from "./memory/schemas.js";

export { DecisionDocSchema, LoopEventSchema, ToolCallSchema };
export type { Run, Message, MemoryDoc, DecisionDoc, SymbolDoc, Convention, Category, LoopEvent, ToolCall };

// ── 2. small value types (previously inline) ─────────────────────────────────
export const GateResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().default(""),
  gate: z.string().nullable().default(null),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const MetricRecordSchema = z.object({
  project: z.string().default("eval"),
  benchmark: z.string(),
  model: z.string(),
  harness: z.boolean(),
  total: z.number().int(),
  passed: z.number().int(),
  ts: z.date().default(() => new Date()),
});
export type MetricRecord = z.infer<typeof MetricRecordSchema>;
export const metricRate = (m: MetricRecord): number => (m.total ? m.passed / m.total : 0);

export const ProviderCapabilitiesSchema = z.object({
  toolUse: z.boolean().default(false),
  jsonMode: z.boolean().default(false),
  maxContext: z.number().int().default(0),
  streaming: z.boolean().default(false),
  caching: z.boolean().default(false),
  hostAdapter: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

// ── 3. structural ports the core depends on ──────────────────────────────────
import type { ChatOpts, ChatTurn, CompleteOpts } from "./providers/base.js";

/** The only model interface the harness knows about (see providers/base.ts). */
export interface ProviderPort {
  readonly name: string;
  complete(prompt: string, opts?: CompleteOpts): Promise<string>;
  chat(messages: Record<string, unknown>[], opts?: ChatOpts): Promise<ChatTurn>;
  countTokens(text: string): number;
  capabilities(): ProviderCapabilities;
}

/** A callable tool with a name + JSON-schema input (see tools/base.ts). */
export interface ToolPort {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

/** The durable-memory gateway the core reads/writes through (see memory/store.ts). */
export interface MemoryPort {
  upsertMemory(doc: MemoryDoc): Promise<string>;
  appendMessage(msg: Message): Promise<void>;
  logEvent(event: LoopEvent): Promise<void>;
  vectorSearch(collection: string, queryEmbedding: number[], opts?: Record<string, unknown>): Promise<unknown[]>;
  textSearch(collection: string, query: string, opts?: Record<string, unknown>): Promise<unknown[]>;
}

/** How a task is driven to completion (the default is orchestration.runAgent). */
export interface LoopStrategy {
  run(prompt: string, project: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type ModelRole = "primary" | "secondary" | "host";
