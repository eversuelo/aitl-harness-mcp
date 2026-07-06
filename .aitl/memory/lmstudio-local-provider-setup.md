---
name: lmstudio-local-provider-setup
description: >-
  Cómo correr el harness contra LM Studio local (provider lmstudio, ADR-0038) +
  gotcha del server vs daemon
type: reference
category: reference
tags:
  - lmstudio
  - provider
  - setup
  - adr-0038
  - gotcha
version: 1
updated_at: 2026-07-02T05:19:05.402Z
---
Correr AITL-Harness-JS contra un modelo local con el provider `lmstudio` (ADR-0038).

**Setup verificado (2026-07-02):**
1. Iniciar el API server OpenAI-compatible. GOTCHA: el proceso de LM Studio abre un daemon interno (visto en :41343) que NO sirve `/v1` — hay que iniciar el server explícitamente. El CLI `lms` no está en PATH; está en `%USERPROFILE%\.lmstudio\bin\lms.exe`. Comando: `& "$env:USERPROFILE\.lmstudio\bin\lms.exe" server start` → "Server is now running on port 1234". Verificar: `curl http://localhost:1234/v1/models`.
2. En `.env` (gitignored): `LMSTUDIO_MODEL=google/gemma-4-e4b` (el id EXACTO que devuelve /v1/models), `LMSTUDIO_BASE_URL=http://localhost:1234/v1`, `LMSTUDIO_API_KEY=lm-studio`, `LMSTUDIO_MAX_CONTEXT=32768`.
3. Usar: `npx tsx src/cli.ts run "..." --project demo --model lmstudio [--stream] [--ask] [--mcp]`, `aitl chat --model lmstudio`, `aitl sdd "..." --model lmstudio`.

gemma-4-e4b soporta tool calling (necesario para el loop) y responde en ~1s a prompts cortos. Costo cero, offline, reproducible → ideal para el piloto de la tesis. Ver la lección de round-trip en [[gap-analysis-harness-tesis]] / ADR-0043.
