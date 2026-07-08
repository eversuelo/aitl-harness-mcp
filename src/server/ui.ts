/**
 * `aitl ui` launcher — starts BOTH processes together:
 *   1. the memory-admin HTTP API (`createApiServer`, this process), and
 *   2. the Vite dev server for the React SPA (child process, `web/`).
 *
 * The SPA talks to the API through Vite's dev proxy (`web/vite.config.ts`), so the
 * two run on separate ports but feel like one app. Ctrl-C tears both down.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeClient, getDb } from "../db/client.js";
import { ensureMongoose } from "../db/mongoose.js";
import { bootstrapBaseUser } from "../auth/users.js";
import { captureBootProfile } from "../config/store.js";
import { createApiServer } from "./api.js";

/**
 * Guided restart (ADR-0061): `POST /api/admin/restart` shuts the process down
 * with this code (EX_TEMPFAIL) and `aitl ui --watch-restart` respawns on it —
 * any other exit code is a real stop.
 */
export const RESTART_EXIT_CODE = 75;

/** Pure: should the `--watch-restart` supervisor respawn after this exit code? */
export function shouldRespawn(code: number | null): boolean {
  return code === RESTART_EXIT_CODE;
}

/**
 * Pure: core collections a bootstrapped AITL database always has. Their absence
 * marks a virgin DB (fresh profile) that needs the one-time `initDb` — checking
 * names is one cheap roundtrip vs. paying `ensureVectorIndexes` on every boot.
 */
export function missingCoreCollections(existing: string[]): string[] {
  const core = ["users", "memory"];
  return core.filter((c) => !existing.includes(c));
}

export interface StartUiOpts {
  apiPort: number;
  webPort: number;
  web: boolean;
  project?: string;
}

/** Absolute path to the `web/` SPA directory, relative to this module. */
function webDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
}

/** Resolve the locally-installed Vite CLI entry (undefined if not installed). */
function resolveViteBin(): string | undefined {
  const req = createRequire(import.meta.url);
  try {
    return join(dirname(req.resolve("vite/package.json")), "bin", "vite.js");
  } catch {
    try {
      const entry = req.resolve("vite");
      return join(dirname(entry), "bin", "vite.js");
    } catch {
      return undefined;
    }
  }
}

function startViteDevServer(opts: StartUiOpts): ChildProcess | undefined {
  const bin = resolveViteBin();
  if (!bin) {
    console.warn(
      "[ui] Vite is not installed — starting the API only. " +
        "Run `pnpm install` (devDeps) or use `--no-web`.",
    );
    return undefined;
  }
  const args = [bin, "--port", String(opts.webPort), "--strictPort"];
  const child = spawn(process.execPath, args, {
    cwd: webDir(),
    stdio: "inherit",
    env: {
      ...process.env,
      // The SPA reads these at dev time to default the API target + project.
      VITE_API_PORT: String(opts.apiPort),
      VITE_DEFAULT_PROJECT: opts.project ?? "",
    },
  });
  child.on("error", (err) => console.error(`[ui] failed to start Vite: ${err.message}`));
  return child;
}

/** Start the API + (optionally) the Vite dev server, wiring graceful shutdown. */
export async function startUi(opts: StartUiOpts): Promise<void> {
  // Snapshot "what this process runs with" BEFORE serving: pending_restart in
  // /api/config/status is the diff between a fresh resolution and this (ADR-0061).
  captureBootProfile();

  // Virgin DB (fresh profile) → run the idempotent initDb once. Degrades to a
  // warning without Mongo (F9): the UI still starts and setup mode takes over.
  try {
    await ensureMongoose();
    const names = (await getDb().listCollections().toArray()).map((c) => c.name);
    const missing = missingCoreCollections(names);
    if (missing.length) {
      const { initDb } = await import("../db/init.js");
      const report = await initDb();
      console.log(
        `[ui] fresh database (missing: ${missing.join(", ")}) → init-db (vector: ${report.vector.ok ? "ok" : "fallback"})`,
      );
    }
  } catch (err) {
    console.warn(
      `[ui] mongo unreachable — starting in setup mode: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const user = await bootstrapBaseUser();
    if (user.status !== "skipped") {
      console.log(`[ui] bootstrap user: ${user.status}${user.username ? ` (${user.username})` : ""}`);
    }
  } catch (err) {
    console.warn(`[ui] bootstrap user skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Late-bound so the API can request the exit-75 restart once `shutdown` exists.
  let requestRestart = () => {
    console.warn("[ui] restart requested before the server finished booting — ignored");
  };
  const api = createApiServer({ requestRestart: () => requestRestart() });
  await new Promise<void>((resolve) => api.listen(opts.apiPort, resolve));
  console.log(`[ui] memory-admin API → http://localhost:${opts.apiPort}/api`);

  const vite = opts.web ? startViteDevServer(opts) : undefined;
  if (opts.web && vite) console.log(`[ui] React SPA (Vite) → http://localhost:${opts.webPort}`);

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(code === RESTART_EXIT_CODE ? "\n[ui] restarting…" : "\n[ui] shutting down…");
    vite?.kill();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await closeClient();
    process.exit(code);
  };
  requestRestart = () => void shutdown(RESTART_EXIT_CODE);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // If Vite dies, bring the whole UI down so the user notices.
  vite?.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[ui] Vite exited (code ${code}); stopping the API.`);
      void shutdown();
    }
  });
}
