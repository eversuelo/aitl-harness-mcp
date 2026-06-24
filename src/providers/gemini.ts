/**
 * Gemini provider (provider #1 in the incremental rollout).
 *
 * Uses the `@google/genai` SDK. Normalizes Gemini's response into the harness's
 * provider-agnostic ChatTurn so the loop never sees anything Gemini-specific. The SDK
 * is loaded lazily (optional dependency) so the package imports without it installed.
 */

import { settings } from "../config.js";
import type { ProviderCapabilities } from "../contracts.js";
import { optionalImport } from "../util/optional.js";
import { type ChatOpts, type ChatTurn, type CompleteOpts, type Provider, estimateTokens } from "./base.js";

// Map the harness's internal roles to Gemini's ("model" instead of "assistant").
const ROLE_MAP: Record<string, string> = { user: "user", assistant: "model", system: "user", tool: "user" };

export class GeminiProvider implements Provider {
  readonly name: string;
  private ai: any = null;
  private model: string;

  constructor(opts: { name?: string; model?: string } = {}) {
    if (!settings.geminiApiKey) {
      throw new Error(
        "GEMINI_API_KEY is empty. Create a free key in Google AI Studio, then set it with `aitl config set GEMINI_API_KEY <key>`.",
      );
    }
    this.name = opts.name ?? "gemini";
    this.model = opts.model ?? settings.geminiModel;
  }

  private async client(): Promise<any> {
    if (this.ai === null) {
      const { GoogleGenAI } = await optionalImport("@google/genai");
      this.ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });
    }
    return this.ai;
  }

  private toContents(messages: Record<string, unknown>[]) {
    return messages.map((m) => ({
      role: ROLE_MAP[String(m.role)] ?? "user",
      parts: [{ text: String(m.content ?? "") }],
    }));
  }

  private toolsConfig(tools?: Record<string, unknown>[]) {
    if (!tools?.length) return undefined;
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? t.parameters ?? {},
        })),
      },
    ];
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    const ai = await this.client();
    const resp = await ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { systemInstruction: opts.system, maxOutputTokens: opts.maxTokens ?? 1024 },
    });
    return resp.text ?? "";
  }

  async chat(messages: Record<string, unknown>[], opts: ChatOpts = {}): Promise<ChatTurn> {
    const ai = await this.client();
    const resp = await ai.models.generateContent({
      model: this.model,
      contents: this.toContents(messages),
      config: {
        systemInstruction: opts.system,
        maxOutputTokens: opts.maxTokens ?? 4096,
        tools: this.toolsConfig(opts.tools),
      },
    });

    const calls = (resp.functionCalls ?? []) as { name: string; args?: Record<string, unknown> }[];
    const tool_calls = calls.map((fc, i) => ({ id: `${fc.name}-${i}`, name: fc.name, input: fc.args ?? {} }));
    const usage = resp.usageMetadata ?? {};
    const candidate = resp.candidates?.[0];
    return {
      text: resp.text ?? "",
      tool_calls,
      usage: { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 },
      stop_reason: candidate?.finishReason ?? null,
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  capabilities(): ProviderCapabilities {
    return { toolUse: true, jsonMode: true, maxContext: 1_000_000, streaming: true, caching: true, hostAdapter: false };
  }
}
