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

  if (name === "openrouter") {
    // OpenRouter is the single model gateway (OpenAI-compatible) → reuse OpenAIProvider.
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider({
      name: "openrouter",
      apiKey: settings.openrouterApiKey,
      model: settings.openrouterModel,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/eversuelo/AITL-Harness-JS",
        "X-Title": "AITL-Harness",
      },
    });
  }
  // Host-based backends (codex / claude-code / antigravity) are served by HostAdapters,
  // not by this raw-model resolver — see src/hosts/ (planned).
  throw new Error(`Unknown provider '${name}'. The only raw-model provider is 'openrouter'.`);
}
