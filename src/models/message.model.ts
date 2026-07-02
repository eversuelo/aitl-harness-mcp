/**
 * Mongoose model for the `messages` collection — one transcript turn (chat).
 *
 * Messages are the durable, shared write-back transcript: every run's turns are appended
 * here (Pain point #4) and read back to resume a run. Carries an optional `embedding` so a
 * turn can be retrieved via Atlas `$vectorSearch` alongside memory and decisions.
 *
 * Extracted from the shared Zod `MessageSchema` (memory/schemas.ts): Mongoose is now the
 * single source of shape + validation + types. `BASE_SCHEMA_OPTS` keeps documents
 * byte-compatible with the pre-migration driver-written docs (no `__v`, no auto timestamps,
 * empty `{}` preserved). `embedding` is set by the embedder on write and stripped only on
 * the documented read projections (never on write) — hence `default: null`, not stripped.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { BASE_SCHEMA_OPTS } from "../db/mongoose.js";
import { ROLES } from "../memory/schemas.js";

export const MESSAGES_COLLECTION = "messages";

const now = () => new Date();

const toolCallSchema = new Schema(
  {
    id: { type: String },
    name: { type: String, required: true },
    input: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false, ...BASE_SCHEMA_OPTS },
);

const messageSchema = new Schema(
  {
    project: { type: String, required: true }, // Project scope; isolates multi-project memory.
    created_at: { type: Date, default: now },
    updated_at: { type: Date, default: now },
    run_id: { type: String, required: true },
    idx: { type: Number, required: true },
    role: { type: String, enum: ROLES, required: true },
    // NOT `required`: Mongoose's required uses truthiness, so it rejects "" — but an
    // empty string is a VALID turn (an assistant message that goes straight to
    // tool_calls has no text). Found on the first live run (gemma-4 via LM Studio);
    // presence is still guaranteed by MessageInput/makeMessage at the type level.
    content: { type: String, default: "" },
    tool_calls: { type: [toolCallSchema], default: [] },
    tool_call_id: { type: String, default: null }, // links a tool result to its call (resume)
    tokens: { type: Number, default: 0 },
    category: { type: String, default: null },
    tags: { type: [String], default: [] },
    embedding: { type: [Number], default: null },
  },
  { ...BASE_SCHEMA_OPTS, collection: MESSAGES_COLLECTION },
);

export type Message = InferSchemaType<typeof messageSchema>;

export const MessageModel = model("Message", messageSchema);

/**
 * Build-input shape for `makeMessage` (mirrors the former Zod `z.input`): plain objects
 * only — `tool_calls` is a plain array of `{ id?, name, input? }`, not a Mongoose
 * `DocumentArray`, so providers/transcripts can pass their raw turn shapes directly.
 */
export type MessageInput = {
  project: string;
  run_id: string;
  idx: number;
  role: Message["role"];
  content: string;
  tool_calls?: { id?: string; name: string; input?: Record<string, unknown> }[];
  tool_call_id?: string | null;
  tokens?: number;
  category?: string | null;
  tags?: string[];
  embedding?: number[] | null;
  created_at?: Date;
  updated_at?: Date;
};

/** Build + validate a message (fills schema defaults). Mirrors the former Zod builder. */
export const makeMessage = (v: MessageInput): Message => {
  const doc = new MessageModel(v);
  const err = doc.validateSync();
  if (err) throw err;
  const obj = doc.toObject() as Message & { _id?: unknown };
  delete obj._id; // Mongo assigns _id on insert; keep the record _id-free like the Zod builder did
  return obj;
};
