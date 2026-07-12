/**
 * Static SPA serving for production (`aitl ui --static` / Docker): the API server
 * streams the built React app (`vite build` → `web/dist`) from the SAME port as
 * `/api`, so one container exposes one shareable URL and the browser needs no CORS.
 *
 * `resolveStaticFile` is pure resolution (path → file/mime/caching) so the traversal
 * guard and the SPA fallback are unit-testable without sockets.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Locate the built SPA. The module runs from two layouts with different depths:
 * source (`src/server` → repo `web/dist`) and compiled (`dist/src/server` → repo
 * `web/dist`, three levels up). Returns null when no build exists.
 */
export function resolveWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../web/dist", "../../../web/dist"]) {
    const candidate = resolve(here, rel);
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export interface StaticFile {
  file: string;
  type: string;
  /** Vite fingerprints /assets/* — safe to cache forever; everything else revalidates. */
  immutable: boolean;
}

/** Map a GET pathname to a file under `root`, with traversal guard + SPA fallback. */
export function resolveStaticFile(root: string, pathname: string): StaticFile | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rootAbs = resolve(root);
  let file = resolve(rootAbs, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  // Traversal guard: anything escaping the root gets the SPA fallback, never the FS.
  if (file !== rootAbs && !file.startsWith(rootAbs + "/")) file = join(rootAbs, "index.html");
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: unknown routes render index.html (client-side routing).
    file = join(rootAbs, "index.html");
    if (!existsSync(file)) return null;
  }
  return {
    file,
    type: MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    immutable: decoded.startsWith("/assets/"),
  };
}
