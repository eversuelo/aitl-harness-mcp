/**
 * Anthropic first-party provider (amends ADR-0020).
 *
 * Direct `@anthropic-ai/sdk` client — NOT the OpenAI-compatible shim — because the
 * features that justify a direct provider don't survive a gateway translation:
 *   - prompt caching (`cache_control` on the system block → ~0.1× cached reads),
 *   - structured outputs (`output_config.format` json_schema),
 *   - native tool_use/tool_result blocks (no lossy function-call adaptation).
 *
 * The harness's normalized conversation (role user/assistant/tool + `tool_calls`
 * as `{id, name, input}`) is adapted to Anthropic wire shape per request, mirroring
 * what `toOpenAiMessages` does for OpenAI-compatible endpoints.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ProviderCapabilities } from "../contracts.js";
import {
  type ChatOpts,
  type ChatTurn,
  type CompleteOpts,
  type Provider,
  type StreamDelta,
  estimateTokens,
} from "./base.js";

export interface AnthropicProviderOpts {
  apiKey?: string;
  model?: string;
  maxContext?: number;
}

type ContentBlockParam = Anthropic.ContentBlockParam;

/**
 * Adapt the harness's normalized conversation to Anthropic wire shape.
 *
 * - assistant turns with `tool_calls` become content blocks `[text?, tool_use…]`;
 * - `role:"tool"` results become `tool_result` blocks inside a user turn
 *   (consecutive tool results are merged into ONE user message);
 * - a tool result without a `tool_call_id` degrades to a plain text block
 *   (can happen on transcripts resumed from providers that omit call ids).
 *
 * Exported for tests (same discipline as `toOpenAiMessages`).
 */
export function toAnthropicMessages(messages: Record<string, unknown>[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  const pushUserBlocks = (blocks: ContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      (last.content as ContentBlockParam[]).push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  };

  for (const m of messages) {
    const role = m.role as string;
    const text = typeof m.content === "string" ? m.content : "";

    if (role === "assistant") {
      const rawCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const blocks: ContentBlockParam[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const [i, tc] of rawCalls.entries()) {
        const c = tc as { id?: string; name?: string; input?: unknown };
        blocks.push({
          type: "tool_use",
          id: c.id ?? `call_${out.length}_${i}`,
          name: c.name ?? "",
          input: (c.input ?? {}) as Record<string, unknown>,
        });
      }
      // Anthropic rejects an empty assistant content array — skip no-op turns.
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }

    if (role === "tool") {
      const id = (m.tool_call_id as string | null | undefined) ?? null;
      pushUserBlocks(
        id
          ? [{ type: "tool_result", tool_use_id: id, content: text }]
          : [{ type: "text", text: `[tool result]\n${text}` }],
      );
      continue;
    }

    // user (and any stray system feedback line) → plain user text turn.
    if (text) pushUserBlocks([{ type: "text", text }]);
  }
  return out;
}

/** Map the harness tool schema ({name, description, input_schema, parameters}) to Anthropic's. */
function toAnthropicTools(tools: Record<string, unknown>[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    input_schema: (t.input_schema ?? t.parameters ?? { type: "object" }) as Anthropic.Tool.InputSchema,
  }));
}

/** Normalize an Anthropic response into the harness's ChatTurn. */
function toChatTurn(msg: Anthropic.Message): ChatTurn {
  let text = "";
  const tool_calls: ChatTurn["tool_calls"] = [];
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      tool_calls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
  }
  return {
    text,
    tool_calls,
    usage: { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 },
    stop_reason: msg.stop_reason,
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  private maxContext: number;

  constructor(opts: AnthropicProviderOpts = {}) {
    const apiKey = opts.apiKey ?? "";
    if (!apiKey) throw new Error("anthropic: set ANTHROPIC_API_KEY (or use `aitl config set`).");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-opus-4-8";
    this.maxContext = opts.maxContext ?? 1_000_000;
  }

  /** System prompt as a cacheable block: repeated turns read it at ~0.1× input price. */
  private systemBlocks(system?: string): Anthropic.TextBlockParam[] | undefined {
    if (!system) return undefined;
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.system ? { system: this.systemBlocks(opts.system) } : {}),
      ...(opts.jsonSchema
        ? { output_config: { format: { type: "json_schema" as const, schema: opts.jsonSchema.schema } } }
        : {}),
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async chat(messages: Record<string, unknown>[], opts: ChatOpts = {}): Promise<ChatTurn> {
    const tools = toAnthropicTools(opts.tools ?? []);
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.system ? { system: this.systemBlocks(opts.system) } : {}),
      ...(tools.length ? { tools } : {}),
      messages: toAnthropicMessages(messages),
    });
    return toChatTurn(resp);
  }

  async *chatStream(
    messages: Record<string, unknown>[],
    opts: ChatOpts = {},
  ): AsyncGenerator<StreamDelta, ChatTurn, void> {
    const tools = toAnthropicTools(opts.tools ?? []);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.system ? { system: this.systemBlocks(opts.system) } : {}),
      ...(tools.length ? { tools } : {}),
      messages: toAnthropicMessages(messages),
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }
    return toChatTurn(await stream.finalMessage());
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  capabilities(): ProviderCapabilities {
    return {
      toolUse: true,
      jsonMode: true,
      maxContext: this.maxContext,
      streaming: true,
      caching: true,
      hostAdapter: false,
    };
  }
}
