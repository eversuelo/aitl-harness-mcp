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
  /**
   * Constrained decoding: ask the backend to guarantee output matching this JSON
   * Schema (OpenAI-compat `response_format: json_schema` — LM Studio supports it —
   * or Anthropic `output_config.format`). Best-effort: backends without support may
   * error, so callers keep their parse-and-repair fallback.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ChatOpts {
  tools?: Record<string, unknown>[];
  system?: string;
  maxTokens?: number;
}

/** Incremental streaming unit (ADR-0005). Kept tiny on purpose: text now; richer
 *  delta kinds (tool_call started, …) can be added without breaking consumers. */
export type StreamDelta = { type: "text"; text: string };

export interface Provider {
  readonly name: string;
  /** Return a single text completion. */
  complete(prompt: string, opts?: CompleteOpts): Promise<string>;
  /** Run one model turn, returning a normalized {text, tool_calls, usage, stop_reason}. */
  chat(messages: Record<string, unknown>[], opts?: ChatOpts): Promise<ChatTurn>;
  /**
   * Optional streaming variant (ADR-0005): yields text deltas and RETURNS the same
   * normalized ChatTurn `chat()` would resolve (usage included). Providers without
   * streaming leave it undefined; callers fall back to `chat()`.
   */
  chatStream?(
    messages: Record<string, unknown>[],
    opts?: ChatOpts,
  ): AsyncGenerator<StreamDelta, ChatTurn, void>;
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

  if (name === "auto") {
    // "auto" is ALWAYS the full fallback chain (F9): the active provider first, then
    // every other configured backend. Same semantics as `aitl chat`; explicit names
    // ('anthropic', 'lmstudio', …) still resolve to that single backend only.
    return getProviderWithFallback((from, to, error) => {
      console.error(`[aitl] provider fallback: ${from} → ${to} (${error})`);
    });
  }
  if (name === "anthropic") {
    // First-party Anthropic API (amends ADR-0020): prompt caching + structured
    // outputs + native tool blocks — features a gateway translation loses.
    const { AnthropicProvider } = await import("./anthropic.js");
    return new AnthropicProvider({
      apiKey: settings.anthropicApiKey,
      model: settings.anthropicModel,
      maxContext: settings.anthropicMaxContext,
    });
  }
  if (name === "openrouter") {
    // OpenRouter is the single model gateway (OpenAI-compatible) → reuse OpenAIProvider.
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider({
      name: "openrouter",
      apiKey: settings.openrouterApiKey,
      model: settings.openrouterModel,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/eversuelo/aitl-mcp",
        "X-Title": "AITL-Harness",
      },
    });
  }
  if (name === "lmstudio") {
    // LM Studio serves an OpenAI-compatible endpoint (Developer tab → Start server,
    // or `lms server start`). Local models are free/offline — reproducible pilot runs.
    let model = settings.lmstudioModel;
    let maxContext = settings.lmstudioMaxContext;
    if (!model) {
      // Empty LMSTUDIO_MODEL: ask the native API which model is ACTUALLY loaded and
      // use it for this process only — `aitl models --detect` is what persists it.
      // Fails actionably when the server is down, nothing is loaded, or >1 is loaded.
      const { detectLmStudioModel } = await import("./lmstudioDetect.js");
      const detected = await detectLmStudioModel(settings.lmstudioBaseUrl);
      model = detected.id;
      // The context the server actually allocated beats the configured/default cap.
      if (detected.loaded_context_length) maxContext = detected.loaded_context_length;
    }
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider({
      name: "lmstudio",
      apiKey: settings.lmstudioApiKey || "lm-studio", // LM Studio ignores it, ctor requires it
      model,
      baseURL: settings.lmstudioBaseUrl,
      maxContext,
    });
  }

  if (name === "openai-compat") {
    // Any other OpenAI-compatible endpoint (Ollama /v1, vLLM, LiteLLM, private gateways).
    if (!settings.openaiCompatBaseUrl || !settings.openaiCompatModel) {
      throw new Error("openai-compat: set OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL.");
    }
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider({
      name: "openai-compat",
      apiKey: settings.openaiCompatApiKey || "none", // many local servers ignore the key
      model: settings.openaiCompatModel,
      baseURL: settings.openaiCompatBaseUrl,
      maxContext: settings.openaiCompatMaxContext,
    });
  }

  // Host-based backends (codex / claude-code / antigravity) are served by HostAdapters,
  // not by this raw-model resolver — see src/hosts/ (planned).
  throw new Error(
    `Unknown provider '${name}'. Raw-model providers: 'anthropic' | 'openrouter' | 'lmstudio' | 'openai-compat' | 'auto'.`,
  );
}

/**
 * Name of the first provider with usable configuration, or null when none is set up.
 * Order: an explicitly configured MODEL_PRIMARY wins; otherwise anthropic → openrouter
 * → lmstudio → openai-compat. Used by `--model auto` and the chat entrypoints, so the
 * CLI can offer a chat whenever *any* LLM is configured.
 */
const RAW_PROVIDERS = ["anthropic", "openrouter", "lmstudio", "openai-compat"] as const;

function isConfigured(n: string): boolean {
  if (n === "anthropic") return Boolean(settings.anthropicApiKey);
  if (n === "openrouter") return Boolean(settings.openrouterApiKey);
  // NOTE: load-state autodetection only kicks in on an EXPLICIT `--model lmstudio`;
  // the auto/fallback chain stays deterministic and needs LMSTUDIO_MODEL set.
  if (n === "lmstudio") return Boolean(settings.lmstudioModel);
  if (n === "openai-compat") return Boolean(settings.openaiCompatBaseUrl && settings.openaiCompatModel);
  return false;
}

export function detectConfiguredProvider(): string | null {
  const primary = settings.modelPrimary;
  if (primary && primary !== "auto" && isConfigured(primary)) return primary;
  for (const n of RAW_PROVIDERS) if (isConfigured(n)) return n;
  return null;
}

export interface ProviderStatusEntry {
  name: string;
  configured: boolean;
  model: string;
  /** What made it (un)configured — the env var(s) involved. */
  via: string;
}

export interface ProviderStatus {
  /** All raw-model backends and whether each is usable right now. */
  providers: ProviderStatusEntry[];
  /** Provider `--model auto` (and the chat entrypoints) would pick. */
  active: string | null;
  /** Remaining configured providers, in the order the fallback chain tries them. */
  fallbacks: string[];
  /** AITL_API_KEY classification result, when that convenience key is set. */
  aitl_api_key?: "anthropic" | "openrouter" | "unclassified";
}

/** Snapshot of which LLM backends are configured (drives `aitl models` and the chat banner). */
export function providerStatus(): ProviderStatus {
  const providers: ProviderStatusEntry[] = [
    {
      name: "anthropic",
      configured: isConfigured("anthropic"),
      model: settings.anthropicModel,
      via: "ANTHROPIC_API_KEY (o AITL_API_KEY sk-ant-*)",
    },
    {
      name: "openrouter",
      configured: isConfigured("openrouter"),
      model: settings.openrouterModel,
      via: "OPENROUTER_API_KEY (o AITL_API_KEY sk-or-*)",
    },
    {
      name: "lmstudio",
      configured: isConfigured("lmstudio"),
      model: settings.lmstudioModel || "(LMSTUDIO_MODEL sin definir — detéctalo con `aitl models --detect`)",
      via: "LMSTUDIO_MODEL + servidor local",
    },
    {
      name: "openai-compat",
      configured: isConfigured("openai-compat"),
      model: settings.openaiCompatModel || "(OPENAI_COMPAT_MODEL sin definir)",
      via: "OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_MODEL",
    },
  ];
  const active = detectConfiguredProvider();
  const fallbacks = providers.filter((p) => p.configured && p.name !== active).map((p) => p.name);
  const status: ProviderStatus = { providers, active, fallbacks };
  if (settings.aitlApiKey) {
    status.aitl_api_key = settings.aitlApiKey.startsWith("sk-ant-")
      ? "anthropic"
      : settings.aitlApiKey.startsWith("sk-or-")
        ? "openrouter"
        : "unclassified";
  }
  return status;
}

/**
 * Provider with automatic fallback: tries the primary and, when a call fails hard
 * (connection refused, auth error, 5xx…), replays it on the next configured backend.
 * Complements the loop's `withRetry` (same-provider transient retry) — this switches
 * BACKENDS. Streaming only falls back when the failure happens before the first
 * delta (a half-streamed turn is not silently replayed).
 */
export class FallbackProvider implements Provider {
  readonly name: string;
  private chain: Provider[];
  private onFallback?: (from: string, to: string, error: string) => void;

  constructor(chain: Provider[], onFallback?: (from: string, to: string, error: string) => void) {
    if (!chain.length) throw new Error("FallbackProvider: empty chain.");
    this.chain = chain;
    this.name = chain.length === 1 ? chain[0].name : `${chain[0].name}→${chain.slice(1).map((p) => p.name).join("→")}`;
    this.onFallback = onFallback;
  }

  private async tryEach<T>(fn: (p: Provider) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const [i, p] of this.chain.entries()) {
      try {
        return await fn(p);
      } catch (err) {
        lastErr = err;
        const next = this.chain[i + 1];
        if (next) this.onFallback?.(p.name, next.name, String(err instanceof Error ? err.message : err).slice(0, 200));
      }
    }
    throw lastErr;
  }

  complete(prompt: string, opts?: CompleteOpts): Promise<string> {
    return this.tryEach((p) => p.complete(prompt, opts));
  }

  chat(messages: Record<string, unknown>[], opts?: ChatOpts): Promise<ChatTurn> {
    return this.tryEach((p) => p.chat(messages, opts));
  }

  async *chatStream(
    messages: Record<string, unknown>[],
    opts?: ChatOpts,
  ): AsyncGenerator<StreamDelta, ChatTurn, void> {
    for (const [i, p] of this.chain.entries()) {
      const gen = p.chatStream
        ? p.chatStream(messages, opts)
        : (async function* (prov: Provider): AsyncGenerator<StreamDelta, ChatTurn, void> {
            // Await INSIDE the generator so a rejected chat() surfaces at gen.next()
            // (inside the try below) and falls back to the next backend.
            return await prov.chat(messages, opts);
          })(p);
      let started = false;
      try {
        let next = await gen.next();
        while (!next.done) {
          started = true;
          yield next.value;
          next = await gen.next();
        }
        return next.value;
      } catch (err) {
        const nextP = this.chain[i + 1];
        // After the first delta the turn is half-emitted — don't silently replay it.
        if (started || !nextP) throw err;
        this.onFallback?.(p.name, nextP.name, String(err instanceof Error ? err.message : err).slice(0, 200));
      }
    }
    throw new Error("FallbackProvider: unreachable");
  }

  countTokens(text: string): number {
    return this.chain[0].countTokens(text);
  }

  capabilities(): ProviderCapabilities {
    return this.chain[0].capabilities();
  }
}

/**
 * Actionable message when NO model backend is configured (F9): the harness still
 * works in memory mode (search/hydrate/sync/capture) and over external hosts, so the
 * error must say so instead of just listing env vars.
 */
export const NO_BACKEND_MESSAGE =
  "No hay backend de modelo configurado. Opciones:\n" +
  "  - configura AITL_API_KEY (sk-ant-*/sk-or-*), ANTHROPIC_API_KEY u OPENROUTER_API_KEY,\n" +
  "  - o un provider local: LMSTUDIO_MODEL (LM Studio) / OPENAI_COMPAT_BASE_URL+OPENAI_COMPAT_MODEL,\n" +
  "  - o corre en modo memoria (aitl search / hydrate / sync / capture-session),\n" +
  "  - o delega a un host: aitl run-host \"<tarea>\" --project <p> --host claude-code\n" +
  "Revisa el estado con: aitl models";

/**
 * Build the auto chain: the active provider first, then every other configured
 * backend as fallback. With a single backend this is just that provider.
 */
export async function getProviderWithFallback(
  onFallback?: (from: string, to: string, error: string) => void,
): Promise<Provider> {
  const status = providerStatus();
  if (!status.active) {
    throw new Error(NO_BACKEND_MESSAGE);
  }
  const chain: Provider[] = [await getProvider(status.active)];
  for (const n of status.fallbacks) chain.push(await getProvider(n));
  return chain.length === 1 ? chain[0] : new FallbackProvider(chain, onFallback);
}
