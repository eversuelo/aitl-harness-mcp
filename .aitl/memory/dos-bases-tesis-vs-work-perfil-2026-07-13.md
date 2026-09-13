---
name: dos-bases-tesis-vs-work-perfil-2026-07-13
description: >-
  Dos bases Atlas separadas por directorio: tesis (web-sites) vs work/Customs
  City (Cluster0, perfil `work`). Cómo se enruta y por qué el perfil NO se
  activa en el manifiesto.
type: reference
category: decision
tags:
  - config
  - perfiles
  - mcp
  - adr-0061
  - multi-db
version: 1
updated_at: 2026-07-13T20:21:36.282Z
branch: feat/harness-v2
commit_sha: ac395a7bf0004a55df98d4838dc856f885cdb1df
---
SETUP DE DOS BASES DE DATOS (2026-07-13). El usuario tiene DOS clusters Atlas con el mismo esquema `aitl`, y el binding es POR DIRECTORIO:

| Directorio | Servidor MCP | Cluster | Catálogo |
|---|---|---|---|
| `~/Code/thesis-harness/AITL-Harness-JS` | `aitl-js` | `web-sites.0sqblvc` | Ray Tracer / Raytracer Lab (tesis) |
| `~/Code/Work/` (+ `cc15-client`, `cc15-feathers`) | `aitl-mcp` | `Cluster0/m2pdgbz` | Customs City (customs/trade compliance) |

== CÓMO SE ENRUTA ==
- Perfil con nombre `work` (ADR-0061) en `~/.aitl/profiles/work.json` con SOLO las 3 claves de Mongo (URI del Cluster0, fallback local:27018, DB `aitl`). El secreto vive AHÍ y en ningún otro sitio.
- Los `.mcp.json` de los tres directorios de work declaran el servidor `aitl-mcp` = `aitl mcp` (binario global; `aitl-mcp@0.1.0` está npm-linkeado a este repo) con env `AITL_PROFILE=work` — SIN URI. `.mcp.json` añadido al `.gitignore` de ambos repos de la empresa.
- CLI: función `aitl()` en `~/.bashrc` que exporta `AITL_PROFILE=work` cuando `$PWD` está bajo `~/Code/Work` (+ `.env` con `AITL_PROFILE=work` en `Work/`, que no es repo git).

== POR QUÉ EL PERFIL NO SE ACTIVA EN EL MANIFIESTO (trampa) ==
`aitl config profile use work` sería un ERROR: la cascada de `src/config.ts:96` es **env real > perfil > `.env` (dotenv) > `~/.aitl/config.json`**, así que un perfil activo globalmente ECLIPSARÍA el `.env` del repo de la tesis y le cambiaría la base. La activación tiene que ser por directorio vía `AITL_PROFILE`, nunca en `profiles.json`.

Corolario de la misma cascada: el bloque `env` de un `.mcp.json` es *env real* y gana a todo — por eso el server `aitl-js` sigue clavado al cluster de la tesis aunque haya perfiles.

== OTROS HALLAZGOS ==
- `dotenv` solo lee el `.env` del cwd: NO se hereda de `Work/` a los subrepos. De ahí la función en `.bashrc` (cubre además subrepos futuros).
- El `config.json` original del usuario (`~/Downloads/config.json`) traía `MODEL_PRIMARY: "gemini"` / `MODEL_SECONDARY: "openai"`: NO son providers válidos de este harness (`auto|anthropic|openrouter|lmstudio|openai-compat`, ver `src/providers/base.ts:71`) y reventarían al primer `aitl run`. Se dejaron fuera del perfil.
- `cc15-client` tiene su `.env` TRACKEADO en git (mala práctica del repo de la empresa): nunca poner secretos ahí.
