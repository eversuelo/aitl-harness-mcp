/**
 * User-level config file — makes the harness usable when installed globally (`npm i -g`).
 *
 * A global CLI has no project-local `.env`, so configuration lives in
 * `~/.aitl/config.json` as a portable profile of ENV-style keys (the same names as
 * `.env.example`). Resolution precedence (highest wins):
 *
 *     process.env  >  ~/.aitl/config.json  >  built-in zod defaults
 *
 * This module owns ONLY the file (read/write/export/import). It must not import
 * `../config.js` (which consumes it) to avoid a cycle.
 */

import { promises as fs, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Canonical ENV keys the harness understands (kept in sync with `.env.example`). */
export const ENV_KEYS = [
  "MONGODB_URI",
  "MONGODB_DB",
  "MODEL_PRIMARY",
  "MODEL_SECONDARY",
  "MODEL_HOST",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FREE_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMS",
  "VOYAGE_API_KEY",
  "MEMORY_MAX_DOCS",
  "MEMORY_MAX_TOKENS",
  "ENABLED_ADAPTERS",
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];
export type ConfigProfile = Partial<Record<EnvKey, string>>;

/** Keys whose values are secrets and must be masked unless explicitly exported. */
export const SECRET_KEYS: ReadonlySet<EnvKey> = new Set<EnvKey>([
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "VOYAGE_API_KEY",
]);

const ENV_KEY_SET: ReadonlySet<string> = new Set(ENV_KEYS);

/** `~/.aitl` (override the base dir with `AITL_HOME` for tests / sandboxes). */
export function configDir(): string {
  return process.env.AITL_HOME ?? join(homedir(), ".aitl");
}

export function configFilePath(): string {
  return join(configDir(), "config.json");
}

/** Read the profile from disk. Returns `{}` if missing or malformed (never throws). */
export function readConfigFile(): ConfigProfile {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const out: ConfigProfile = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (ENV_KEY_SET.has(k) && v != null) out[k as EnvKey] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the profile, optionally merging onto the existing file. Returns the path. */
export async function writeConfigFile(
  profile: ConfigProfile,
  opts: { merge?: boolean } = {},
): Promise<string> {
  const next = opts.merge ? { ...readConfigFile(), ...profile } : { ...profile };
  const path = configFilePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return path;
}

/** Keep only recognized ENV keys with non-empty string values. */
export function sanitizeProfile(input: Record<string, unknown>): ConfigProfile {
  const out: ConfigProfile = {};
  for (const [k, v] of Object.entries(input)) {
    if (ENV_KEY_SET.has(k) && v != null && String(v) !== "") out[k as EnvKey] = String(v);
  }
  return out;
}

/** Mask a secret value for display (keeps a short suffix for recognizability). */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "••••";
  return `••••${value.slice(-4)}`;
}

/** Hide credentials in a MongoDB URI (mirrors db/client.redactMongoUri without importing it). */
export function redactUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/?#]+@)/i, "$1<credentials>@");
}

/**
 * The effective profile = env over file, mapped to ENV keys. Secrets are masked
 * unless `includeSecrets` is set (so `config export` is safe to share by default).
 */
export function resolveProfile(opts: { includeSecrets?: boolean } = {}): ConfigProfile {
  const file = readConfigFile();
  const out: ConfigProfile = {};
  for (const key of ENV_KEYS) {
    // Empty env vars don't shadow stored profile values (see config.ts).
    const fromEnv = process.env[key];
    const value = fromEnv != null && fromEnv !== "" ? fromEnv : file[key];
    if (value == null || value === "") continue;
    if (!opts.includeSecrets && SECRET_KEYS.has(key)) out[key] = maskSecret(value);
    else if (!opts.includeSecrets && key === "MONGODB_URI") out[key] = redactUri(value);
    else out[key] = value;
  }
  return out;
}
