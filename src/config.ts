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

const SettingsSchema = z.object({
  // ── MongoDB ──────────────────────────────────────────────────────────
  mongodbUri: z.string().default("mongodb://localhost:27017/?directConnection=true"),
  mongodbDb: z.string().default("aitl"),

  // ── Model providers (incremental: gemini -> openai -> antigravity -> gemini-antigravity) ──
  modelPrimary: z.enum(["gemini", "google-free", "gemini-free", "openai", "anthropic", "antigravity"]).default("gemini"),
  modelSecondary: z.enum(["gemini", "google-free", "gemini-free", "openai", "anthropic", "antigravity"]).default("openai"),
  modelHost: z.string().default(""), // optional host wrapping a provider (e.g. antigravity)
  geminiApiKey: z.string().default(""),
  geminiModel: z.string().default("gemini-2.5-pro"),
  geminiFreeModel: z.string().default("gemini-3.5-flash"),
  openaiApiKey: z.string().default(""),
  openaiModel: z.string().default("gpt-5.5"),
  // Legacy, kept behind the ProviderPort (not foco).
  anthropicApiKey: z.string().default(""),
  anthropicModel: z.string().default("claude-opus-4-8"),

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
    mongodbUri: env("MONGODB_URI"),
    mongodbDb: env("MONGODB_DB"),
    modelPrimary: env("MODEL_PRIMARY"),
    modelSecondary: env("MODEL_SECONDARY"),
    modelHost: env("MODEL_HOST"),
    geminiApiKey: env("GEMINI_API_KEY"),
    geminiModel: env("GEMINI_MODEL"),
    geminiFreeModel: env("GEMINI_FREE_MODEL"),
    openaiApiKey: env("OPENAI_API_KEY"),
    openaiModel: env("OPENAI_MODEL"),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    anthropicModel: env("ANTHROPIC_MODEL"),
    embeddingProvider: env("EMBEDDING_PROVIDER"),
    embeddingModel: env("EMBEDDING_MODEL"),
    embeddingDims: env("EMBEDDING_DIMS"),
    voyageApiKey: env("VOYAGE_API_KEY"),
    memoryMaxDocs: env("MEMORY_MAX_DOCS"),
    memoryMaxTokens: env("MEMORY_MAX_TOKENS"),
    enabledAdapters: env("ENABLED_ADAPTERS"),
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
