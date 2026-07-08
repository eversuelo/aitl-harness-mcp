/**
 * Central configuration for AITL-Harness.
 *
 * All settings come from environment variables / a `.env` file (see `.env.example`).
 * Nothing else in the codebase should read `process.env` directly — import `settings`
 * from here so configuration stays in one place and is validated by zod.
 */

import { z } from "zod";
// NOTE: importing store.js also loads `.env` (dotenv moved there for provenance,
// ADR-0061) — keep this import first-ish so settings see the same layers.
import { type EnvKey, resolvedEnv } from "./config/store.js";

function normalizeMongoUri(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const queryIndex = uri.indexOf("?");
  if (queryIndex === -1) return uri;

  // JSON-escaped Atlas URIs sometimes get copied into dotenv files, where
  // `\u0026` stays literal and breaks MongoDB option parsing.
  const prefix = uri.slice(0, queryIndex + 1);
  const query = uri.slice(queryIndex + 1).replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=");
  return `${prefix}${query}`;
}

const SettingsSchema = z.object({
  // ── MongoDB ──────────────────────────────────────────────────────────
  mongodbUri: z.string().default("mongodb://localhost:27017/?directConnection=true"),
  // Optional second URI tried when the primary is unreachable (local <-> Atlas).
  mongodbUriFallback: z.string().default(""),
  mongodbDb: z.string().default("aitl"),

  // ── Model backend ──
  // Raw models go through OpenRouter (one OpenAI-compatible gateway). Agent HOSTS
  // (codex / claude-code / antigravity) are driven by HostAdapters (modelHost), planned.
  // Plain strings (not a strict enum) so a stale value never crashes settings load;
  // an unknown name fails clearly only when `getProvider` actually tries to use it.
  modelPrimary: z.string().default("openrouter"),
  modelSecondary: z.string().default("openrouter"),
  modelHost: z.string().default(""), // agent host the harness runs over (codex|claude-code|antigravity)
  // Single-key convenience: AITL_API_KEY is classified by prefix (sk-ant-* → Anthropic,
  // sk-or-* → OpenRouter) and fills the matching provider key when that one is unset.
  aitlApiKey: z.string().default(""),
  // OpenRouter: OpenAI-compatible gateway to many models (model ids are namespaced).
  openrouterApiKey: z.string().default(""),
  openrouterModel: z.string().default("openrouter/auto"),
  // Anthropic direct (first-party API): unlocks prompt caching + structured outputs
  // that don't survive an OpenAI-compatible gateway. Amends ADR-0020.
  anthropicApiKey: z.string().default(""),
  anthropicModel: z.string().default("claude-opus-4-8"),
  anthropicMaxContext: z.coerce.number().int().default(1_000_000),
  // LM Studio: local OpenAI-compatible server (Developer tab → Start server, or
  // `lms server start`). Free, offline, reproducible — ideal for pilot runs.
  lmstudioBaseUrl: z.string().default("http://localhost:1234/v1"),
  lmstudioModel: z.string().default(""),
  lmstudioApiKey: z.string().default("lm-studio"), // placeholder; LM Studio ignores it
  lmstudioMaxContext: z.coerce.number().int().default(32_768),
  // Generic OpenAI-compatible endpoint (Ollama /v1, vLLM, LiteLLM, private gateways).
  openaiCompatBaseUrl: z.string().default(""),
  openaiCompatModel: z.string().default(""),
  openaiCompatApiKey: z.string().default(""),
  openaiCompatMaxContext: z.coerce.number().int().default(128_000),

  // ── Embeddings ───────────────────────────────────────────────────────
  // NOTE: embeddingDims MUST match the vector index (src/db/indexes.ts).
  embeddingProvider: z.enum(["local", "voyage"]).default("local"),
  embeddingModel: z.string().default("Xenova/all-MiniLM-L6-v2"),
  embeddingDims: z.coerce.number().int().default(384),
  voyageApiKey: z.string().default(""),

  // ── Memory synthesis trigger (per project) ───────────────────────────
  memoryMaxDocs: z.coerce.number().int().default(500),
  memoryMaxTokens: z.coerce.number().int().default(200_000),

  // ── Adapters (cross-tool, incremental, opt-in) ───────────────────────
  enabledAdapters: z.string().default("agents_md"),

  // ── Bootstrap user (optional, idempotent) ─────────────────────────────
  bootstrapUsername: z.string().default(""),
  bootstrapEmail: z.string().default(""),
  bootstrapPassword: z.string().default(""),
  bootstrapRole: z.string().default("root"),
  // When no valid seed exists and `users` is empty, auto-generate a local root.
  // Set AITL_BOOTSTRAP_AUTOGEN=false (multi-tenant) to disable the fallback.
  bootstrapAutogen: z
    .preprocess((v) => (v === undefined ? undefined : !/^(false|0|no|off)$/i.test(String(v))), z.boolean())
    .default(true),
});

export type Settings = z.infer<typeof SettingsSchema> & { adapters: string[] };

function loadSettings(): Settings {
  // Layered resolution (ADR-0061): real env > active named profile > `.env` >
  // ~/.aitl/config.json > zod defaults. `resolvedEnv` owns the layering and
  // treats "" as unset at every layer (see config/store.ts).
  const env = (key: EnvKey): string | undefined => resolvedEnv(key);

  const parsed = SettingsSchema.parse({
    mongodbUri: normalizeMongoUri(env("MONGODB_URI")),
    mongodbUriFallback: normalizeMongoUri(env("MONGODB_URI_FALLBACK")),
    mongodbDb: env("MONGODB_DB"),
    modelPrimary: env("MODEL_PRIMARY"),
    modelSecondary: env("MODEL_SECONDARY"),
    modelHost: env("MODEL_HOST"),
    aitlApiKey: env("AITL_API_KEY"),
    openrouterApiKey: env("OPENROUTER_API_KEY"),
    openrouterModel: env("OPENROUTER_MODEL"),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    anthropicModel: env("ANTHROPIC_MODEL"),
    anthropicMaxContext: env("ANTHROPIC_MAX_CONTEXT"),
    lmstudioBaseUrl: env("LMSTUDIO_BASE_URL"),
    lmstudioModel: env("LMSTUDIO_MODEL"),
    lmstudioApiKey: env("LMSTUDIO_API_KEY"),
    lmstudioMaxContext: env("LMSTUDIO_MAX_CONTEXT"),
    openaiCompatBaseUrl: env("OPENAI_COMPAT_BASE_URL"),
    openaiCompatModel: env("OPENAI_COMPAT_MODEL"),
    openaiCompatApiKey: env("OPENAI_COMPAT_API_KEY"),
    openaiCompatMaxContext: env("OPENAI_COMPAT_MAX_CONTEXT"),
    embeddingProvider: env("EMBEDDING_PROVIDER"),
    embeddingModel: env("EMBEDDING_MODEL"),
    embeddingDims: env("EMBEDDING_DIMS"),
    voyageApiKey: env("VOYAGE_API_KEY"),
    memoryMaxDocs: env("MEMORY_MAX_DOCS"),
    memoryMaxTokens: env("MEMORY_MAX_TOKENS"),
    enabledAdapters: env("ENABLED_ADAPTERS"),
    bootstrapUsername: env("AITL_BOOTSTRAP_USERNAME"),
    bootstrapEmail: env("AITL_BOOTSTRAP_EMAIL"),
    bootstrapPassword: env("AITL_BOOTSTRAP_PASSWORD"),
    bootstrapRole: env("AITL_BOOTSTRAP_ROLE"),
    bootstrapAutogen: env("AITL_BOOTSTRAP_AUTOGEN"),
  });
  // Single-key classification: AITL_API_KEY fills the matching provider key by prefix
  // (only when that provider key is not already set explicitly).
  if (parsed.aitlApiKey) {
    if (parsed.aitlApiKey.startsWith("sk-ant-") && !parsed.anthropicApiKey) {
      parsed.anthropicApiKey = parsed.aitlApiKey;
    } else if (parsed.aitlApiKey.startsWith("sk-or-") && !parsed.openrouterApiKey) {
      parsed.openrouterApiKey = parsed.aitlApiKey;
    }
    // Unknown prefixes are left alone — `aitl models` reports them as unclassified.
  }

  return {
    ...parsed,
    get adapters() {
      return parsed.enabledAdapters
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
    },
  };
}

let _settings: Settings | null = null;

/** Cached singleton. Call this everywhere instead of re-parsing the env. */
export function getSettings(): Settings {
  if (_settings === null) _settings = loadSettings();
  return _settings;
}

// Convenience module-level handle.
export const settings = getSettings();
