/**
 * Named config profiles (ADR-0061) — CRUD over `~/.aitl/profiles/<name>.json`.
 *
 * A profile is an overlay on the base `~/.aitl/config.json`: it pins only the
 * keys it defines (typically MONGODB_URI / MONGODB_URI_FALLBACK / MONGODB_DB
 * for a work/personal context) and everything else falls through to the base
 * file. Resolution lives in `./store.js` (layerLookup); this module owns file
 * management only and must not import `../config.js` (which consumes store).
 */

import { promises as fs, existsSync, readdirSync } from "node:fs";
import {
  ENV_KEYS,
  PROFILE_NAME_RE,
  SECRET_KEYS,
  type ConfigProfile,
  type EnvKey,
  activeProfileName,
  maskSecret,
  profileFilePath,
  profilesDir,
  readProfileFile,
  redactUri,
  writeProfilesManifest,
} from "./store.js";

/** Names that would collide with the base config files inside ~/.aitl. */
const RESERVED_NAMES = new Set(["config", "profiles"]);

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
    throw new Error(
      `Invalid profile name '${name}'. Use lowercase letters/digits/._- (max 32, ` +
        `must start alphanumeric); reserved: ${[...RESERVED_NAMES].join(", ")}.`,
    );
  }
}

export interface ProfileSummary {
  name: string;
  keys: EnvKey[];
  active: boolean;
}

export function listProfiles(): ProfileSummary[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  const active = activeProfileName();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((name) => PROFILE_NAME_RE.test(name))
    .sort()
    .map((name) => ({
      name,
      keys: Object.keys(readProfileFile(name)) as EnvKey[],
      active: name === active,
    }));
}

/** Create/update a profile. `null`/"" values unset keys; unknown keys throw. */
export async function writeProfile(
  name: string,
  updates: Record<string, string | null>,
  opts: { merge?: boolean } = {},
): Promise<string> {
  validateProfileName(name);
  const unknown = Object.keys(updates).filter((k) => !(ENV_KEYS as readonly string[]).includes(k));
  if (unknown.length) {
    throw new Error(`Unknown config key(s): ${unknown.join(", ")}. Known: ${ENV_KEYS.join(", ")}`);
  }
  const next: ConfigProfile = opts.merge === false ? {} : { ...readProfileFile(name) };
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === "") delete next[k as EnvKey];
    else next[k as EnvKey] = String(v);
  }
  const path = profileFilePath(name);
  await fs.mkdir(profilesDir(), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return path;
}

/** Delete a profile file. Throws when it is the active one; false when absent. */
export async function deleteProfile(name: string): Promise<boolean> {
  validateProfileName(name);
  if (activeProfileName() === name) {
    throw new Error(`Profile '${name}' is active. Switch first (aitl config profile use --none).`);
  }
  const path = profileFilePath(name);
  if (!existsSync(path)) return false;
  await fs.rm(path);
  return true;
}

/** Point the manifest at `name` (null = no profile). Throws when it doesn't exist. */
export async function setActiveProfile(name: string | null): Promise<void> {
  if (name !== null) {
    validateProfileName(name);
    if (!existsSync(profileFilePath(name))) {
      throw new Error(
        `Profile '${name}' does not exist. Create it first (aitl config profile set ${name} <KEY> <value>).`,
      );
    }
  }
  await writeProfilesManifest({ active: name });
}

/** One profile's stored keys, masked like `resolveProfile` (for display/API). */
export function resolveProfileView(
  name: string,
  opts: { includeSecrets?: boolean } = {},
): ConfigProfile {
  validateProfileName(name);
  const stored = readProfileFile(name);
  if (opts.includeSecrets) return stored;
  const out: ConfigProfile = {};
  for (const [k, v] of Object.entries(stored) as [EnvKey, string][]) {
    if (SECRET_KEYS.has(k)) out[k] = maskSecret(v);
    else if (k === "MONGODB_URI" || k === "MONGODB_URI_FALLBACK") out[k] = redactUri(v);
    else out[k] = v;
  }
  return out;
}
