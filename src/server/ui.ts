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
import { closeClient } from "../db/client.js";
import { createApiServer } from "./api.js";

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
  try {
    return createRequire(import.meta.url).resolve("vite/bin/vite.js");
  } catch {
    return undefined;
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
  const api = createApiServer();
  await new Promise<void>((resolve) => api.listen(opts.apiPort, resolve));
  console.log(`[ui] memory-admin API → http://localhost:${opts.apiPort}/api`);

  const vite = opts.web ? startViteDevServer(opts) : undefined;
  if (opts.web && vite) console.log(`[ui] React SPA (Vite) → http://localhost:${opts.webPort}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[ui] shutting down…");
    vite?.kill();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await closeClient();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // If Vite dies, bring the whole UI down so the user notices.
  vite?.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[ui] Vite exited (code ${code}); stopping the API.`);
      void shutdown();
    }
  });
}
