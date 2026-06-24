/**
 * Provider abstraction — the only model interface the harness knows about.
 *
 * A Provider exposes:
 *   - complete(prompt) -> string  : one-shot text completion (classifier/synthesizer)
 *   - chat(messages, tools) -> ChatTurn : a single model turn that may request tools
 *
 * Keeping this surface tiny is what makes the harness model-agnostic: swapping
 * Anthropic <-> OpenAI <-> a local model is a config change, not a code change.
 */

import { settings } from "../config.js";
import type { ProviderCapabilities } from "../contracts.js";

export interface ChatTurn {
  text: string; // assistant text (may be empty)
  tool_calls: { id?: string; name: string; input: Record<string, unknown> }[];
  usage: { input: number; output: number };
  stop_reason: string | null;
}

export interface CompleteOpts {
  system?: string;
  maxTokens?: number;
}

export interface ChatOpts {
  tools?: Record<string, unknown>[];
  system?: string;
  maxTokens?: number;
}

export interface Provider {
  readonly name: string;
  /** Return a single text completion. */
  complete(prompt: string, opts?: CompleteOpts): Promise<string>;
  /** Run one model turn, returning a normalized {text, tool_calls, usage, stop_reason}. */
  chat(messages: Record<string, unknown>[], opts?: ChatOpts): Promise<ChatTurn>;
  /** Rough ~4-chars/token estimate by default; providers may use a real tokenizer. */
  countTokens(text: string): number;
  /** Declare what this provider/host can do (the loop never infers these). */
  capabilities(): ProviderCapabilities;
}

/** Shared default token estimate so providers can `countTokens = estimateTokens`. */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

/** Resolve a Provider by config role ('primary'/'secondary') or explicit name. */
export async function getProvider(which?: string): Promise<Provider> {
  const role = which ?? settings.modelPrimary;
  const name =
    role === "primary"
      ? settings.modelPrimary
      : role === "secondary"
        ? settings.modelSecondary
        : role;

  if (name === "gemini") {
    const { GeminiProvider } = await import("./gemini.js");
    return new GeminiProvider();
  }
  if (name === "google-free" || name === "gemini-free") {
    const { GeminiProvider } = await import("./gemini.js");
    return new GeminiProvider({ name, model: settings.geminiFreeModel });
  }
  if (name === "openai") {
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider();
  }
  if (name === "anthropic") {
    // legacy, kept behind the port
    const { AnthropicProvider } = await import("./anthropic.js");
    return new AnthropicProvider();
  }
  throw new Error(`Unknown provider '${name}'. Expected 'gemini', 'google-free', 'gemini-free', 'openai' or 'anthropic'.`);
}
