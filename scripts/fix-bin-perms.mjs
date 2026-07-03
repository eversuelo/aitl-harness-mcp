// tsc writes 644; the global `aitl` bin is a symlink into dist (npm i -g . links the
// project dir), so every rebuild would drop the exec bit → "Permiso denegado".
// Restore it for the entrypoints after each build.
import { chmodSync } from "node:fs";

for (const f of ["dist/src/cli.js", "dist/src/mcpserver/server.js"]) {
  try {
    chmodSync(f, 0o755);
  } catch {
    // entrypoint not built (partial build) — nothing to fix
  }
}
