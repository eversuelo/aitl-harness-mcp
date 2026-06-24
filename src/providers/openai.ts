/** OpenAI provider (second backend → proves model-agnosticism). */

import OpenAI from "openai";
import { settings } from "../config.js";
import type { ProviderCapabilities } from "../contracts.js";
import { type ChatOpts, type ChatTurn, type CompleteOpts, type Provider, estimateTokens } from "./base.js";

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor() {
    if (!settings.openaiApiKey) throw new Error("OPENAI_API_KEY is empty.");
    this.client = new OpenAI({ apiKey: settings.openaiApiKey });
    this.model = settings.openaiModel;
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
    const msgs = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      ...messages,
    ] as unknown as OpenAI.ChatCompletionMessageParam[];

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

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  capabilities(): ProviderCapabilities {
    return { toolUse: true, jsonMode: true, maxContext: 128_000, streaming: true, caching: true, hostAdapter: false };
  }
}
