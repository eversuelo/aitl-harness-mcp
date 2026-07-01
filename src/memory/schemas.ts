/**
 * Zod schemas for the memory-layer documents still owned by Zod.
 *
 * Historically every durable collection had its schema here. The durable CORE collections
 * (messages, memory, decisions, decisions_history, memory_history, events) have since moved
 * to Mongoose models (single source of shape + validation + types):
 *   Message      → src/models/message.model.ts
 *   MemoryDoc    → src/models/memory.model.ts
 *   ADR          → src/models/decision.model.ts
 *   HistoryEntry → src/models/history.model.ts (decisions_history + memory_history)
 *   Event        → src/models/event.model.ts
 *
 * What remains here: the shared enums/value types those models re-import (MEMORY_TYPES,
 * ROLES, ToolCall). The `Run` schema/builder moved to src/models/run.model.ts (M6).
 */

import { z } from "zod";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference", "synthesis"] as const;
export const ROLES = ["user", "assistant", "tool", "system"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Role = (typeof ROLES)[number];

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  input: z.record(z.unknown()).default({}),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
