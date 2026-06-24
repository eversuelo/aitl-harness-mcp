/** Anthropic provider. */

import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config.js";
import type { ProviderCapabilities } from "../contracts.js";
import { type ChatOpts, type ChatTurn, type CompleteOpts, type Provider, estimateTokens } from "./base.js";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor() {
    if (!settings.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is empty.");
    this.client = new Anthropic({ apiKey: settings.anthropicApiKey });
    this.model = settings.anthropicModel;
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system ?? "",
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async chat(messages: Record<string, unknown>[], opts: ChatOpts = {}): Promise<ChatTurn> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system ?? "",
      messages: messages as unknown as Anthropic.MessageParam[],
      tools: (opts.tools ?? []) as unknown as Anthropic.Tool[],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const tool_calls = resp.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
    return {
      text,
      tool_calls,
      usage: { input: resp.usage.input_tokens, output: resp.usage.output_tokens },
      stop_reason: resp.stop_reason,
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  capabilities(): ProviderCapabilities {
    return { toolUse: true, jsonMode: true, maxContext: 200_000, streaming: true, caching: true, hostAdapter: false };
  }
}
