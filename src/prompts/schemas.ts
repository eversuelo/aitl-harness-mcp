/**
 * Prompt history — durable record of the prompts/instructions given to the agent.
 *
 * Shares the `prompts` collection with the MCP server's record_prompt/list_prompts/
 * search_prompts tools (same document shape), so the CLI and the MCP read/write the
 * SAME history. This collection is intentionally NOT part of the shared `COLLECTIONS`
 * list in db/client.ts, keeping the Python↔TS parity contract untouched.
 */

import { z } from "zod";

export const PROMPT_COLLECTION = "prompts";

export const PromptRecordSchema = z.object({
  project: z.string(),
  prompt: z.string(),
  title: z.string().default(""),
  source: z.string().default("cli"), // cli | mcp | ui | …
  model: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.date().default(() => new Date()),
});
export type PromptRecord = z.infer<typeof PromptRecordSchema>;

export const makePromptRecord = (v: z.input<typeof PromptRecordSchema>): PromptRecord =>
  PromptRecordSchema.parse(v);
