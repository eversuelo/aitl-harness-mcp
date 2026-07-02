/**
 * Generic OpenAI-compatible provider.
 *
 * Parameterized by `baseURL`/`apiKey`/`model`, so it backs any OpenAI-compatible
 * endpoint. The harness uses it for **OpenRouter** (the single model gateway) — see
 * `getProvider`. It carries no provider-specific config of its own.
 */

import OpenAI from "openai";
import type { ProviderCapabilities } from "../contracts.js";
import {
  type ChatOpts,
  type ChatTurn,
  type CompleteOpts,
  type Provider,
  type StreamDelta,
  estimateTokens,
} from "./base.js";

// ── streaming accumulator (pure, exported for tests — ADR-0005) ───────────────
// OpenAI streams tool calls FRAGMENTED: `delta.tool_calls[].index` names a slot,
// `id`/`function.name` arrive on the slot's first fragment, and `function.arguments`
// arrives as string pieces to concatenate. The final usage chunk (needs
// `stream_options.include_usage`) carries `usage` with an EMPTY `choices` array.

export interface StreamAccState {
  text: string;
  toolSlots: Map<number, { id?: string; name: string; args: string }>;
  finish: string | null;
  usage: { input: number; output: number };
}

export function newStreamAccState(): StreamAccState {
  return { text: "", toolSlots: new Map(), finish: null, usage: { input: 0, output: 0 } };
}

/** Fold one chunk into the state; returns the text delta ("" when none). */
export function foldStreamChunk(state: StreamAccState, chunk: OpenAI.ChatCompletionChunk): string {
  if (chunk.usage) {
    state.usage = {
      input: chunk.usage.prompt_tokens ?? 0,
      output: chunk.usage.completion_tokens ?? 0,
    };
  }
  const choice = chunk.choices?.[0];
  if (!choice) return ""; // e.g. the usage-only final chunk
  if (choice.finish_reason) state.finish = choice.finish_reason;
  const delta = choice.delta ?? {};
  for (const tc of delta.tool_calls ?? []) {
    const slot = state.toolSlots.get(tc.index) ?? { name: "", args: "" };
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name = tc.function.name;
    if (tc.function?.arguments) slot.args += tc.function.arguments;
    state.toolSlots.set(tc.index, slot);
  }
  const text = typeof delta.content === "string" ? delta.content : "";
  state.text += text;
  return text;
}

/** Resolve the accumulated state into the same normalized ChatTurn `chat()` returns. */
export function finishStream(state: StreamAccState): ChatTurn {
  const tool_calls = [...state.toolSlots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(slot.args || "{}") as Record<string, unknown>;
      } catch {
        input = {}; // malformed fragment stream — mirror chat()'s defensive parse
      }
      return { ...(slot.id ? { id: slot.id } : {}), name: slot.name, input };
    });
  return { text: state.text, tool_calls, usage: state.usage, stop_reason: state.finish };
}

export interface OpenAIProviderOpts {
  name?: string;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /** Context window reported by capabilities() — local models are often smaller. */
  maxContext?: number;
}

/**
 * Adapt the harness's normalized conversation back to OpenAI wire shape before a
 * request. The loop persists/re-sends assistant tool calls as `{id, name, input}`
 * (our ChatTurn shape), but the API expects
 * `{id, type:"function", function:{name, arguments:<json string>}}`. Without this the
 * SECOND turn after any tool call is rejected ("Invalid 'messages' in payload") —
 * i.e. every tool-using run breaks. System/user/plain-assistant/tool messages pass
 * through unchanged.
 */
export function toOpenAiMessages(messages: Record<string, unknown>[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    const raw = m.tool_calls;
    if (m.role === "assistant" && Array.isArray(raw) && raw.length) {
      const tool_calls = raw.map((tc) => {
        const c = tc as { id?: string; name?: string; input?: unknown };
        return {
          id: c.id ?? "",
          type: "function" as const,
          function: { name: c.name ?? "", arguments: JSON.stringify(c.input ?? {}) },
        };
      });
      // OpenAI wants content:null (not "") on an assistant message that only calls tools.
      const content = typeof m.content === "string" && m.content ? m.content : null;
      return { role: "assistant", content, tool_calls } as OpenAI.ChatCompletionMessageParam;
    }
    return m as unknown as OpenAI.ChatCompletionMessageParam;
  });
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  private client: OpenAI;
  private model: string;
  private maxContext: number;

  constructor(opts: OpenAIProviderOpts = {}) {
    this.name = opts.name ?? "openai-compatible";
    const apiKey = opts.apiKey ?? "";
    if (!apiKey) throw new Error(`${this.name}: API key is empty.`);
    this.client = new OpenAI({
      apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
    });
    this.model = opts.model ?? "openrouter/auto";
    this.maxContext = opts.maxContext ?? 128_000;
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      { role: "user", content: prompt },
    ];
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: msgs,
      max_tokens: opts.maxTokens ?? 1024,
    });
    return resp.choices[0].message.content ?? "";
  }

  async chat(messages: Record<string, unknown>[], opts: ChatOpts = {}): Promise<ChatTurn> {
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      ...toOpenAiMessages(messages),
    ];

    // OpenAI expects tools in {type:"function", function:{...}} shape; callers pass
    // the normalized harness tool schema, adapted here.
    const oaiTools = (opts.tools ?? []).map((t) => ({ type: "function" as const, function: t }));

    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: msgs,
      tools: oaiTools.length ? (oaiTools as unknown as OpenAI.ChatCompletionTool[]) : undefined,
      max_tokens: opts.maxTokens ?? 4096,
    });
    const choice = resp.choices[0].message;
    const tool_calls = (choice.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
    }));
    return {
      text: choice.content ?? "",
      tool_calls,
      usage: {
        input: resp.usage?.prompt_tokens ?? 0,
        output: resp.usage?.completion_tokens ?? 0,
      },
      stop_reason: resp.choices[0].finish_reason,
    };
  }

  async *chatStream(
    messages: Record<string, unknown>[],
    opts: ChatOpts = {},
  ): AsyncGenerator<StreamDelta, ChatTurn, void> {
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      ...toOpenAiMessages(messages),
    ];
    const oaiTools = (opts.tools ?? []).map((t) => ({ type: "function" as const, function: t }));

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: msgs,
      tools: oaiTools.length ? (oaiTools as unknown as OpenAI.ChatCompletionTool[]) : undefined,
      max_tokens: opts.maxTokens ?? 4096,
      stream: true,
      // Some OpenAI-compatible servers (older LM Studio builds) skip the usage chunk;
      // the turn then reports 0 tokens — documented in the --stream CLI help.
      stream_options: { include_usage: true },
    });
    const state = newStreamAccState();
    for await (const chunk of stream) {
      const text = foldStreamChunk(state, chunk);
      if (text) yield { type: "text", text };
    }
    return finishStream(state);
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  capabilities(): ProviderCapabilities {
    return { toolUse: true, jsonMode: true, maxContext: this.maxContext, streaming: true, caching: true, hostAdapter: false };
  }
}
