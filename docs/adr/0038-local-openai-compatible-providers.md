# ADR-0038 — Local OpenAI-compatible providers (lmstudio, openai-compat)

- **Status:** Accepted
- **Date:** 2026-07-01

## Context
Since ADR-0020, the only raw-model provider is `openrouter` — a cloud gateway that
needs an API key and network access. The thesis pilot needs runs that are (a) free of
marginal cost, (b) offline-capable, and (c) **reproducible**: a local GGUF model pinned
by id can be re-run by a reviewer years later, while "model X via a cloud API in July
2026" cannot. LM Studio serves any loaded local model behind an OpenAI-compatible
endpoint (Developer tab → Start server, or `lms server start`), and the same wire
format is spoken by Ollama (`/v1`), vLLM and LiteLLM.

Replacing OpenRouter was rejected: supporting **both** a cloud gateway and local
runtimes through one `ProviderPort` is precisely the model-agnosticism claim the
harness exists to demonstrate.

## Decision
1. `getProvider` resolves two new names, both reusing `OpenAIProvider` (no new SDK):
   - **`lmstudio`** — `LMSTUDIO_BASE_URL` (default `http://localhost:1234/v1`),
     `LMSTUDIO_MODEL` (required at use time, clear error otherwise), `LMSTUDIO_API_KEY`
     (placeholder `lm-studio`; LM Studio ignores it, the ctor requires a non-empty key).
   - **`openai-compat`** — fully generic: `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_MODEL`
     required, `OPENAI_COMPAT_API_KEY` optional (`none` placeholder).
2. `OpenAIProviderOpts` gains `maxContext`, surfaced by `capabilities().maxContext`
   and configured per provider (`LMSTUDIO_MAX_CONTEXT` default 32768,
   `OPENAI_COMPAT_MAX_CONTEXT` default 128000): local models have smaller windows and
   the `ContextManager` budget must follow the active provider, not a constant.
3. The new ENV keys join the user profile (`~/.aitl/config.json`); both `*_API_KEY`s
   are masked as secrets (the base URL may point at an authenticated proxy).

## Consequences
- Pilot runs can execute with zero marginal cost and no key; formal runs keep using
  frontier models via OpenRouter. Conditions C0/C2 become replicable on one machine.
- `MODEL_PRIMARY=lmstudio` makes the local server the default for every loop consumer
  (synthesizer, roles, SDD) — one config change, no code change (the agnosticism claim).
- The loop depends on native tool calling; small local models without it will produce
  degenerate runs. Documented in `.env.example` (choose a tool-calling model).
- `getProvider("nope")` still fails with a clear message listing the three providers.
