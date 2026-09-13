---
name: bug-aitl-ui-vite-enoent-webdir-dist
description: >-
  Bug: `aitl ui` desde el binario global fallaba con "failed to start Vite:
  spawn .../node ENOENT" — webDir() usaba la profundidad del layout de fuente,
  así que en dist/ el cwd de Vite no existía.
type: project
category: bug
tags:
  - bug
  - ui
  - vite
  - dist
  - adr-0073
version: 1
updated_at: 2026-07-13T20:39:03.031Z
branch: feat/harness-v2
commit_sha: ac395a7bf0004a55df98d4838dc856f885cdb1df
---
BUG (2026-07-13, `feat/harness-v2`): `aitl ui` lanzado desde el **binario global** (`dist/src/cli.js`) moría con:

    [ui] failed to start Vite: spawn /home/.../bin/node ENOENT

El mensaje engaña: parece que falta `node`. En realidad **`spawn` reporta ENOENT contra el COMANDO cuando el `cwd` no existe**, no contra el cwd. Repro mínimo: `spawn(process.execPath, ["-e","0"], {cwd: "/no/existe"})` → `error.message = "spawn /usr/bin/node ENOENT"`.

== CAUSA RAÍZ ==
`webDir()` en `src/server/ui.ts` cableaba la profundidad del layout de FUENTE:
`join(dirname(import.meta.url), "..", "..", "web")`.
- desde fuente (`src/server/ui.ts` vía tsx) → `<repo>/web` ✓
- desde el build (`dist/src/server/ui.js`) → **`<repo>/dist/web`** ✗ (no existe)
Y ese path se pasaba como `cwd` al spawn de Vite. Por eso `npm run ui` (tsx) funcionaba y `aitl ui` (global, dist) no.

Lección: `src/server/staticFiles.ts` (`resolveWebDist`, ADR-0073) YA resolvía los dos layouts probando `["../../web/dist", "../../../web/dist"]`. La lección estaba aprendida en el modo `--static` pero no se aplicó a `webDir()`. Al añadir cualquier path relativo al módulo, cubrir SIEMPRE los dos layouts (src y dist/src).

== FIX ==
`resolveWebDir(): string | null` exportada, probando `["../../web", "../../../web"]`, + guard en `startViteDevServer` que degrada a "API only" con mensaje accionable en vez del ENOENT críptico. Test de regresión en `src/server/ui.test.ts`. Verify: 456/456.

== TRAMPA AL ESCRIBIR EL FIX ==
Primer intento usó `package.json` como marcador del directorio → devolvía null: **`web/` NO tiene `package.json` propio** (comparte el del root; de ahí que `vite build` deba correr con `cwd=web` por los globs de Tailwind, ADR-0073). El marcador correcto es `vite.config.ts`.
