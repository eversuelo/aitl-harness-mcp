import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `aitl ui` injects VITE_API_PORT / VITE_DEFAULT_PROJECT; defaults match the CLI.
const apiPort = process.env.VITE_API_PORT ?? "4317";

// Root defaults to this config's directory (web/). The dev server proxies /api to the
// memory-admin HTTP API so the SPA and API feel like one origin (no CORS in the browser).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
});
