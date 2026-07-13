---
name: provider-chutes-404-en-synthesize
description: >-
  La cadena auto de providers devolvió 404 al invocar la tool MCP synthesize
  (2026-07-12): el slot openai-compat (Chutes) apunta a un endpoint/modelo
  inexistente; el fallback extractivo salvó la corrida. Revisar
  MODEL_PRIMARY/base_url del slot.
type: feedback
category: bug
tags:
  - providers
  - chutes
  - openai-compat
  - synthesize
  - bug
version: 1
updated_at: 2026-07-12T03:52:22.003Z
branch: feat/harness-v2
commit_sha: 6dc1d507a01fa6591dbc592725406bc9ca33bcc9
---
2026-07-12: `synthesize {project: aitl-raytracer-orq-sonnet, provider: auto}` vía MCP falló con `404 status code (no body)` — la cadena auto (MODEL_PRIMARY=openai-compat → Chutes, recableado en ADR-0071) llega a un endpoint o modelo que ya no existe. `provider: extractive` funcionó y la síntesis nunca quedó en blanco (contrato ADR-0059), pero la calidad es extractiva, no abstractive.

**Why:** la key/base_url del slot openai-compat se configuró el 2026-07-11 y no hay health-check; un 404 del provider primario degrada TODAS las síntesis automáticas a extractivas sin aviso visible (el error solo emerge cuando se fuerza provider auto).

**How to apply:** (1) verificar `aitl models` / providerStatus contra Chutes: modelo listado vs MODEL_PRIMARY y base_url del slot; (2) si Chutes cambió el path del endpoint o el nombre del modelo, corregir el .env (espejo `aitl config set --env`); (3) considerar que la cadena auto salte al siguiente provider ante 404 (hoy parece propagar el error en vez de degradar) — candidato a fix en FallbackProvider. Relacionado: [[diseno-tool-synthesize-mcp-interop]].
