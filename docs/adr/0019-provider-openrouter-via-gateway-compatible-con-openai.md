# ADR-0019 — Provider OpenRouter vía gateway compatible con OpenAI

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Se quiere usar OpenRouter para acceder a muchos modelos con una sola cuenta/clave. OpenRouter expone una API compatible con OpenAI (/api/v1/chat/completions), así que no hace falta reimplementar el ProviderPort.

## Decision

Parametrizar OpenAIProvider con OpenAIProviderOpts {name, apiKey, model, baseURL, defaultHeaders} para que cualquier gateway OpenAI-compatible reuse su lógica de chat/complete. Añadir la rama 'openrouter' en getProvider que instancia OpenAIProvider con baseURL=https://openrouter.ai/api/v1, settings.openrouterApiKey/openrouterModel y headers HTTP-Referer/X-Title. Nuevas settings OPENROUTER_API_KEY/OPENROUTER_MODEL (default openrouter/auto) en config.ts, config/store.ts (ENV_KEYS + SECRET_KEYS) y .env.example; 'openrouter' agregado a los enums modelPrimary/modelSecondary. Los model ids de OpenRouter son namespaced (anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-exp:free, openrouter/auto).

## Consequences

El harness puede enrutar a cualquier modelo de OpenRouter con MODEL_PRIMARY=openrouter sin código nuevo por modelo; refuerza el agnosticismo de modelo. Verificado: getProvider('openrouter') construye con name 'openrouter', baseURL correcto y capabilities OpenAI; typecheck+build limpios. La llamada real requiere la API key del usuario (no probada end-to-end con modelo vivo todavía).
