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
import dotenv from "dotenv";
import { updateEnvFile } from "./envfile.js";

// ── dotenv with provenance (ADR-0061) ────────────────────────────────────────
// `.env` used to load via `import "dotenv/config"` in config.ts, which made
// repo-local `.env` values indistinguishable from real process env — a `.env`
// would permanently eclipse any named profile. Loading it here records which
// keys dotenv ADDED (vs. vars already set by the caller/CI/supervisor), so the
// layering can slot the active profile ABOVE `.env` but BELOW real env.
const PRE_DOTENV_KEYS = new Set(Object.keys(process.env));
dotenv.config();
const DOTENV_KEYS: ReadonlySet<string> = new Set(
  Object.keys(process.env).filter((k) => !PRE_DOTENV_KEYS.has(k)),
);

let _dotenvKeysOverride: ReadonlySet<string> | null = null;
/** Tests only: override which keys count as dotenv-provided (null restores). */
export function _setDotenvKeysForTests(keys: ReadonlySet<string> | null): void {
  _dotenvKeysOverride = keys;
}
function dotenvKeys(): ReadonlySet<string> {
  return _dotenvKeysOverride ?? DOTENV_KEYS;
}

/** Canonical ENV keys the harness understands (kept in sync with `.env.example`). */
export const ENV_KEYS = [
  "MONGODB_URI",
  "MONGODB_URI_FALLBACK",
  "MONGODB_DB",
  "MODEL_PRIMARY",
  "MODEL_SECONDARY",
  "MODEL_HOST",
  "AITL_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MAX_CONTEXT",
  "LMSTUDIO_BASE_URL",
  "LMSTUDIO_MODEL",
  "LMSTUDIO_API_KEY",
  "LMSTUDIO_MAX_CONTEXT",
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_MAX_CONTEXT",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMS",
  "VOYAGE_API_KEY",
  "MEMORY_MAX_DOCS",
  "MEMORY_MAX_TOKENS",
  "ENABLED_ADAPTERS",
  "AITL_BOOTSTRAP_USERNAME",
  "AITL_BOOTSTRAP_EMAIL",
  "AITL_BOOTSTRAP_PASSWORD",
  "AITL_BOOTSTRAP_ROLE",
  "AITL_BOOTSTRAP_AUTOGEN",
  // Web UI (P3.5): CORS allowlist, editable from the Config tab. Note the API server
  // reads it from process.env, so a profile-only change applies on the next start
  // (the .env mirror covers repo-local runs).
  "AITL_WEB_ORIGINS",
  "AITL_WEB_ALLOW_SIGNUP",
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];
export type ConfigProfile = Partial<Record<EnvKey, string>>;

/** Keys whose values are secrets and must be masked unless explicitly exported. */
export const SECRET_KEYS: ReadonlySet<EnvKey> = new Set<EnvKey>([
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "AITL_API_KEY",
  // LM Studio ignores the key locally, but the base URL may point at an
  // authenticated proxy — masking is free and consistent.
  "LMSTUDIO_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "VOYAGE_API_KEY",
  "AITL_BOOTSTRAP_PASSWORD",
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

export interface ApplyConfigResult {
  /** Path of the user-level profile written (~/.aitl/config.json). */
  profilePath: string;
  /** Path of the mirrored dotenv file (created when missing). */
  envPath: string;
  /** Keys touched — safe to log/audit (values never are). */
  keys: string[];
}

/**
 * Double persistence for config updates (P3.5, used by `PUT /api/config`):
 * write the user-level profile (`~/.aitl/config.json`, same machinery as
 * `aitl config set`) AND mirror the change into the project's `.env` so a
 * repo-local run picks it up too. `null`/empty values unset the key in the
 * profile and comment it out in the `.env`. Only `ENV_KEYS` are accepted;
 * values are never logged (several are secrets).
 */
export async function applyConfigUpdates(
  updates: Record<string, string | null>,
  opts: { envPath?: string } = {},
): Promise<ApplyConfigResult> {
  const unknown = Object.keys(updates).filter((k) => !ENV_KEY_SET.has(k));
  if (unknown.length) {
    throw new Error(`Unknown config key(s): ${unknown.join(", ")}. Known: ${ENV_KEYS.join(", ")}`);
  }

  // Normalize: empty string means "unset", like `aitl config unset`.
  const normalized: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(updates)) normalized[k] = v == null || v === "" ? null : String(v);

  const profile = readConfigFile();
  for (const [k, v] of Object.entries(normalized)) {
    if (v === null) delete profile[k as EnvKey];
    else profile[k as EnvKey] = v;
  }
  const profilePath = await writeConfigFile(profile, { merge: false });

  const envPath = opts.envPath ?? join(process.cwd(), ".env");
  await updateEnvFile(envPath, normalized);

  return { profilePath, envPath, keys: Object.keys(normalized) };
}

// ── Named profiles (ADR-0061) ────────────────────────────────────────────────
// A profile is an OVERLAY: it only pins the keys it defines (typically the
// MONGODB_* trio for a work/personal context); everything else falls through to
// the base config.json. Selection: the AITL_PROFILE env var ("" = explicitly
// none) wins over the manifest's `active`.

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function profilesDir(): string {
  return join(configDir(), "profiles");
}

export function profilesManifestPath(): string {
  return join(configDir(), "profiles.json");
}

export interface ProfilesManifest {
  active: string | null;
}

/** Read the manifest. `{ active: null }` when missing/malformed (never throws). */
export function readProfilesManifest(): ProfilesManifest {
  const path = profilesManifestPath();
  if (!existsSync(path)) return { active: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const active =
      typeof parsed.active === "string" && PROFILE_NAME_RE.test(parsed.active) ? parsed.active : null;
    return { active };
  } catch {
    return { active: null };
  }
}

export async function writeProfilesManifest(manifest: ProfilesManifest): Promise<string> {
  const path = profilesManifestPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return path;
}

export function profileFilePath(name: string): string {
  return join(profilesDir(), `${name}.json`);
}

/** Read one profile overlay. `{}` when missing/malformed/invalid name (never throws). */
export function readProfileFile(name: string): ConfigProfile {
  if (!PROFILE_NAME_RE.test(name)) return {};
  const path = profileFilePath(name);
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

/** The active profile name: AITL_PROFILE env ("" = explicitly none) > manifest. */
export function activeProfileName(): string | null {
  const fromEnv = process.env.AITL_PROFILE;
  if (fromEnv != null) {
    const name = fromEnv.trim();
    return name !== "" && PROFILE_NAME_RE.test(name) ? name : null;
  }
  return readProfilesManifest().active;
}

export function readActiveProfileLayer(): ConfigProfile {
  const name = activeProfileName();
  return name ? readProfileFile(name) : {};
}

// ── Layered resolution ───────────────────────────────────────────────────────

export type ConfigSource = "env" | "profile" | "dotenv" | "file";

export interface ConfigLayers {
  env: NodeJS.ProcessEnv;
  dotenvKeys: ReadonlySet<string>;
  profile: ConfigProfile;
  file: ConfigProfile;
}

/**
 * Pure layered lookup: real env > active profile > `.env` (dotenv) > config.json.
 * Empty strings are "unset" at every layer (see config.ts).
 */
export function layerLookup(
  key: string,
  layers: ConfigLayers,
): { value?: string; source?: ConfigSource } {
  const fromEnv = layers.env[key];
  const hasEnv = fromEnv != null && fromEnv !== "";
  if (hasEnv && !layers.dotenvKeys.has(key)) return { value: fromEnv, source: "env" };
  const fromProfile = layers.profile[key as EnvKey];
  if (fromProfile != null && fromProfile !== "") return { value: fromProfile, source: "profile" };
  if (hasEnv) return { value: fromEnv, source: "dotenv" };
  const fromFile = layers.file[key as EnvKey];
  if (fromFile != null && fromFile !== "") return { value: fromFile, source: "file" };
  return {};
}

function currentLayers(): ConfigLayers {
  return {
    env: process.env,
    dotenvKeys: dotenvKeys(),
    profile: readActiveProfileLayer(),
    file: readConfigFile(),
  };
}

/** Effective value for one ENV key across all layers ("" treated as unset). */
export function resolvedEnv(key: string): string | undefined {
  return layerLookup(key, currentLayers()).value;
}

/** Which layer produced each effective key (provenance hints for the web UI). */
export function resolveProfileSources(): Partial<Record<EnvKey, ConfigSource>> {
  const layers = currentLayers();
  const out: Partial<Record<EnvKey, ConfigSource>> = {};
  for (const key of ENV_KEYS) {
    const { source } = layerLookup(key, layers);
    if (source) out[key] = source;
  }
  return out;
}

/**
 * The effective profile across all layers, mapped to ENV keys. Secrets are masked
 * unless `includeSecrets` is set (so `config export` is safe to share by default).
 */
export function resolveProfile(opts: { includeSecrets?: boolean } = {}): ConfigProfile {
  const layers = currentLayers();
  const out: ConfigProfile = {};
  for (const key of ENV_KEYS) {
    const { value } = layerLookup(key, layers);
    if (value == null || value === "") continue;
    if (!opts.includeSecrets && SECRET_KEYS.has(key)) out[key] = maskSecret(value);
    else if (!opts.includeSecrets && (key === "MONGODB_URI" || key === "MONGODB_URI_FALLBACK"))
      out[key] = redactUri(value);
    else out[key] = value;
  }
  return out;
}

// ── Boot snapshot → pending-restart detection (ADR-0061) ────────────────────
// `settings` (config.ts) freezes at import and the Mongoose connection pins its
// URI/dbName at boot (ADR-0048), so "what runs" is exactly the resolution at
// process start. Diffing a fresh resolution against this snapshot yields the
// keys whose new values only apply after a restart. Only key NAMES ever leave
// this module through the API.
let _bootProfile: ConfigProfile | null = null;

/** Snapshot the effective config at boot (call once, before serving requests). */
export function captureBootProfile(): void {
  _bootProfile = resolveProfile({ includeSecrets: true });
}

/** Keys whose on-disk value now differs from the booted process (names only). */
export function pendingRestartKeys(): EnvKey[] {
  const boot = _bootProfile;
  if (!boot) return [];
  const now = resolveProfile({ includeSecrets: true });
  return ENV_KEYS.filter((key) => boot[key] !== now[key]);
}

export function _resetBootProfileForTests(): void {
  _bootProfile = null;
}
