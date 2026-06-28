/**
 * Central configuration for AITL-Harness.
 *
 * All settings come from environment variables / a `.env` file (see `.env.example`).
 * Nothing else in the codebase should read `process.env` directly — import `settings`
 * from here so configuration stays in one place and is validated by zod.
 */

import "dotenv/config";
import { z } from "zod";
import { type EnvKey, readConfigFile } from "./config/store.js";

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
  // OpenRouter: OpenAI-compatible gateway to many models (model ids are namespaced).
  openrouterApiKey: z.string().default(""),
  openrouterModel: z.string().default("openrouter/auto"),

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
  // Layered resolution: process.env > ~/.aitl/config.json > zod defaults.
  const file = readConfigFile();
  // An empty env var (e.g. a blank `GEMINI_API_KEY=` line in .env) must NOT shadow a
  // value stored in the profile, so treat "" as unset for layering purposes.
  const env = (key: EnvKey): string | undefined => {
    const fromEnv = process.env[key];
    return fromEnv != null && fromEnv !== "" ? fromEnv : file[key];
  };

  const parsed = SettingsSchema.parse({
    mongodbUri: normalizeMongoUri(env("MONGODB_URI")),
    mongodbUriFallback: normalizeMongoUri(env("MONGODB_URI_FALLBACK")),
    mongodbDb: env("MONGODB_DB"),
    modelPrimary: env("MODEL_PRIMARY"),
    modelSecondary: env("MODEL_SECONDARY"),
    modelHost: env("MODEL_HOST"),
    openrouterApiKey: env("OPENROUTER_API_KEY"),
    openrouterModel: env("OPENROUTER_MODEL"),
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
