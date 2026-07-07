/**
 * «Task» branch availability logic (P9) — PURE decision functions + a small PATH probe.
 *
 * The interactive panel's Task branch offers three actions over a user-typed task
 * (Planear / Delegar / Council). Which ones are enabled depends on the environment:
 *
 *   - Planear  needs a raw-model provider (the SDD pipeline drives a model itself).
 *   - Delegar  needs ≥1 available HOST: a HOST_SPECS entry whose binary is on PATH,
 *              or one with an `AITL_HOST_CMD_<NAME>` override (trusted as-is, same
 *              seam `getHost` honors — the e2e fixtures rely on it).
 *   - Council  needs a valid seat plan: ≥2 DISTINCT proponents plus a judge distinct
 *              from all of them (runCouncil enforces both), so "≥2 clientes posibles"
 *              really means ≥3 seats. `planCouncilSeats` encodes the composition rules.
 *
 * Everything here is deterministic and injectable so the unit tests run without
 * spawning hosts, hitting a model, or touching Mongo.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { HOST_SPECS } from "../hosts/base.js";
import { providerStatus } from "../providers/base.js";

// ── PATH probe ────────────────────────────────────────────────────────────────

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // On Windows the X_OK bit is meaningless; existence as a file is enough there.
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `cmd` against `env.PATH` (honoring PATHEXT on Windows). A command that
 * already contains a path separator is checked directly. Returns the resolved path
 * or null — never throws.
 */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd.trim()) return null;
  if (cmd.includes("/") || cmd.includes("\\")) return isExecutableFile(cmd) ? cmd : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

// ── host availability ─────────────────────────────────────────────────────────

/** Env var that overrides a host's command (same rule as `getHost` in hosts/base.ts). */
export function hostOverrideEnvVar(host: string): string {
  return `AITL_HOST_CMD_${host.toUpperCase().replace(/-/g, "_")}`;
}

export interface HostAvailability {
  name: string;
  available: boolean;
  /** How it became available: binary on PATH, or an AITL_HOST_CMD_* override. */
  via: "path" | "override" | null;
  /** The command that would actually run (the override wins, like getHost). */
  command: string;
}

/**
 * Availability of every known host. An `AITL_HOST_CMD_<NAME>` override marks the host
 * available without probing (the user explicitly pointed at a binary/script); otherwise
 * the spec's default command must be on PATH.
 */
export function detectAvailableHosts(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    specs?: Record<string, { command: string }>;
    /** PATH probe seam (tests inject a fake; default: findOnPath against `env`). */
    isOnPath?: (cmd: string) => boolean;
  } = {},
): HostAvailability[] {
  const specs = opts.specs ?? HOST_SPECS;
  const isOnPath = opts.isOnPath ?? ((cmd: string) => findOnPath(cmd, env) !== null);
  return Object.entries(specs).map(([name, spec]) => {
    const override = env[hostOverrideEnvVar(name)]?.trim();
    if (override) return { name, available: true, via: "override" as const, command: override };
    const available = isOnPath(spec.command);
    return { name, available, via: available ? ("path" as const) : null, command: spec.command };
  });
}

export const availableHostNames = (hosts: HostAvailability[]): string[] =>
  hosts.filter((h) => h.available).map((h) => h.name);

// ── action availability ───────────────────────────────────────────────────────

export interface ActionAvailability {
  enabled: boolean;
  /** Why the action is disabled (shown verbatim in the TUI). */
  reason?: string;
}

/** Seat plan for a runnable council: client specs as `makeCouncilClient` takes them. */
export interface CouncilSeats {
  proponents: string[];
  judge: string;
}

/**
 * Compose council seats from available hosts + configured providers (active first).
 * runCouncil requires ≥2 distinct proponents AND a judge distinct from all of them,
 * so the composition prefers hosts as proponents and a provider as judge:
 *
 *   ≥2 hosts + ≥1 provider → hosts propose, provider judges
 *   ≥3 hosts, 0 providers  → all but the last propose, the last judges (splitCouncil rule)
 *   1 host  + ≥2 providers → host + provider propose, second provider judges
 *   0 hosts + ≥3 providers → providers fill every seat
 *   anything else          → not runnable, with the concrete missing piece as reason
 */
export function planCouncilSeats(
  hosts: string[],
  providers: string[],
): { seats?: CouncilSeats; reason?: string } {
  const prov = providers.map((p) => `provider:${p}`);
  if (hosts.length >= 2 && prov.length >= 1) return { seats: { proponents: [...hosts], judge: prov[0] } };
  if (hosts.length >= 3) return { seats: { proponents: hosts.slice(0, -1), judge: hosts[hosts.length - 1] } };
  if (hosts.length === 2) {
    return { reason: "hay 2 hosts pero ningún provider configurado para actuar de juez (el juez debe ser distinto de los proponentes)" };
  }
  if (hosts.length === 1 && prov.length >= 2) {
    return { seats: { proponents: [hosts[0], prov[0]], judge: prov[1] } };
  }
  if (hosts.length === 1 && prov.length === 1) {
    return { reason: "1 host + 1 provider no alcanzan: el consejo necesita ≥2 proponentes y un juez distinto (añade otro host u otro provider)" };
  }
  if (prov.length >= 3) return { seats: { proponents: prov.slice(0, -1), judge: prov[prov.length - 1] } };
  return { reason: "se requieren ≥2 clientes posibles: hosts disponibles (binario en PATH o AITL_HOST_CMD_*) y/o providers configurados" };
}

export interface TaskActions {
  plan: ActionAvailability;
  delegate: ActionAvailability;
  council: ActionAvailability & { seats?: CouncilSeats };
}

/**
 * Which Task-branch actions are enabled given the detected hosts and configured
 * providers. Disabled actions carry the human-readable reason the TUI shows.
 */
export function computeTaskActions(input: { hosts: string[]; providers: string[] }): TaskActions {
  const plan: ActionAvailability = input.providers.length
    ? { enabled: true }
    : { enabled: false, reason: "sin backend de modelo configurado (revisa `aitl models`)" };
  const delegate: ActionAvailability = input.hosts.length
    ? { enabled: true }
    : { enabled: false, reason: "sin hosts disponibles: ningún binario de host en PATH ni override AITL_HOST_CMD_*" };
  const composed = planCouncilSeats(input.hosts, input.providers);
  const council: TaskActions["council"] = composed.seats
    ? { enabled: true, seats: composed.seats }
    : { enabled: false, reason: composed.reason };
  return { plan, delegate, council };
}

/** Configured raw-model providers, active first (thin env wrapper over providerStatus). */
export function configuredProviderNames(): string[] {
  const st = providerStatus();
  return st.active ? [st.active, ...st.fallbacks] : [];
}
