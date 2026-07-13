# ADR-0067 — Autodetección del modelo cargado en LM Studio (API nativa /api/v0)

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/providers, src/cli.ts, src/config

## Context

LMSTUDIO_MODEL debía fijarse a mano y podía divergir del modelo realmente cargado en el servidor (caso real: config apuntando a qwen/qwen3-4b-2507 con mistralai/ministral-3-3b cargado), causando fallos o corridas contra un modelo distinto al que el usuario cree. LM Studio sirve dos APIs en el mismo puerto: /v1 (OpenAI-compat, sin estado de carga) y /api/v0 nativa, cuyo /api/v0/models expone state: loaded|not-loaded, loaded_context_length (el contexto realmente asignado) y capabilities.

## Decision

Nuevo módulo puro e inyectable src/providers/lmstudioDetect.ts (sin import de settings; fetchImpl inyectable para tests): deriva la URL nativa desde LMSTUDIO_BASE_URL (recorta el sufijo /v1 y añade /api/v0/models), filtra modelos chat cargados (llm/vlm; embeddings fuera; sin `type` cuenta como chat) y decide con planLmStudioDetection — solo hay éxito automático con EXACTAMENTE un modelo cargado; la ambigüedad nunca se resuelve en silencio con el primero de la lista. Dos consumidores: (1) getProvider("lmstudio") con LMSTUDIO_MODEL vacío autodetecta por proceso (nada se persiste) y usa loaded_context_length como maxContext real; falla accionable si el servidor está caído, no hay modelo cargado o hay más de uno. (2) `aitl models --detect [id]` persiste LMSTUDIO_MODEL + LMSTUDIO_MAX_CONTEXT en ~/.aitl/config.json (merge), con --env para espejar al ./.env, y avisa cuando otra capa (env real/perfil/dotenv, precedencia ADR-0061) eclipsa lo escrito vía resolveProfileSources. La cadena auto/fallback sigue determinista: isConfigured("lmstudio") sigue exigiendo LMSTUDIO_MODEL; la autodetección solo aplica con selección explícita del provider.

## Consequences

- LM Studio funciona out-of-the-box con LMSTUDIO_MODEL vacío cuando hay un único modelo cargado; el contexto configurado deja de mentir (usa el asignado real del servidor).
- La detección depende de la API nativa v0 de LM Studio (no estándar OpenAI); si cambia, solo se toca lmstudioDetect.ts.
- `--model auto` no cambia de semántica: sin LMSTUDIO_MODEL el backend no entra a la cadena de fallback (sin llamadas de red en providerStatus).
- 8 tests nuevos (suite 401); verificado E2E vivo: --detect persistió mistralai/ministral-3-3b ctx 20000 y getProvider completó un prompt real vía autodetección.
