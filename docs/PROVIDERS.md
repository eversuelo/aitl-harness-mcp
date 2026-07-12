# Providers de modelo — agnosticismo y fallback seguro

> Cómo apuntar el harness a **Anthropic, OpenRouter, Chutes.ai, OpenAI, LM Studio** o
> cualquier endpoint OpenAI-compatible, con fallback automático y **sin multiplicar
> `.env`**. Verificación en un comando: `aitl models`.

## Los 4 slots (ADR-0044)

El harness es agnóstico por diseño: hay exactamente **cuatro backends** de modelo crudo
y todo lo demás se mapea a uno de ellos.

| Slot | Para quién | Variables | Nota |
|---|---|---|---|
| `anthropic` | API first-party de Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | SDK oficial: prompt caching, structured outputs y tool blocks nativos — features que no sobreviven un gateway |
| `openrouter` | Gateway a decenas de modelos (incl. GPT, Gemini, Claude) | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | ids namespaced (`anthropic/claude-3.5-sonnet`, `openrouter/auto`) |
| `lmstudio` | Modelos locales (gratis, offline, reproducible) | `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL` (vacío = autodetección ADR-0067) | elegir modelos con tool calling nativo |
| `openai-compat` | **Cualquier** API estilo OpenAI: **Chutes.ai**, OpenAI directo, Ollama `/v1`, vLLM, LiteLLM, gateways privados | `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_API_KEY` | un solo slot: si necesitas dos de estos a la vez, enruta uno por OpenRouter |

## La cadena `auto` (fallback seguro)

Con `MODEL_PRIMARY=auto` (o `--model auto`), cada corrida:

1. Si `MODEL_PRIMARY` nombra un backend concreto y está configurado, ese es el activo.
2. Si no, se toma el **primer backend configurado** en orden fijo:
   `anthropic → openrouter → lmstudio → openai-compat`.
3. Los demás backends configurados quedan como **cadena de fallback**
   (`FallbackProvider`): si una llamada falla duro (conexión rechazada, auth, 5xx), se
   repite en el siguiente backend. Complementa a `withRetry` (que reintenta fallos
   *transitorios* en el MISMO backend). En streaming solo hay fallback si el fallo
   ocurre antes del primer delta.

Esto da la política «**local primero, nube de respaldo**» sin código: configura LM
Studio + un backend de nube y la cadena hace el resto.

## Recetas mínimas (cuántas variables necesitas de verdad)

```bash
# 1) Solo Anthropic (1 variable — el prefijo sk-ant-* se auto-clasifica)
AITL_API_KEY=sk-ant-...

# 2) Solo Chutes.ai (3-4 variables — cpk_* NO se auto-clasifica, va al slot compat).
#    Config actual de este repo (verificada 2026-07-11: `aitl models` → openai-compat activo):
MODEL_PRIMARY=openai-compat            # determinista; con key de Anthropic cambia a auto
OPENAI_COMPAT_BASE_URL=https://llm.chutes.ai/v1
OPENAI_COMPAT_MODEL=default            # o un model id concreto de Chutes
OPENAI_COMPAT_API_KEY=cpk_...

# 3) Solo OpenAI directo (3 variables, mismo slot)
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
OPENAI_COMPAT_MODEL=gpt-4o-mini
OPENAI_COMPAT_API_KEY=sk-...

# 4) Local primero + Chutes de respaldo (patrón: LM Studio corriendo se autodetecta
#    como activo — ADR-0067 — y la nube queda de fallback; con el server cerrado, auto
#    salta directo a la nube)
MODEL_PRIMARY=auto
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=                        # vacío = autodetección del modelo cargado
OPENAI_COMPAT_BASE_URL=https://llm.chutes.ai/v1
OPENAI_COMPAT_MODEL=default
OPENAI_COMPAT_API_KEY=cpk_...
# → `aitl models`: lmstudio activo, fallback: openai-compat
```

Errores comunes: una key en una variable que el harness **no lee** (p. ej. `API_KEY=`)
queda inerte sin aviso; y `AITL_API_KEY` solo clasifica `sk-ant-*`/`sk-or-*` — cualquier
otro prefijo necesita las variables explícitas de su slot.

## Sin multiplicar `.env` (la parte «segura»)

- **Config a nivel usuario** (ADR-0006): `aitl config set OPENAI_COMPAT_API_KEY cpk_...`
  persiste en `~/.aitl/config.json` — compartida por todos los repos, fuera de git.
  `aitl config show`/`export` **enmascaran secretos** por defecto.
- **Perfiles con nombre** (ADR-0061): `aitl config profile create trabajo` +
  `AITL_PROFILE=trabajo` — un overlay por contexto (trabajo/personal/tesis) sin tocar
  ningún `.env`. Precedencia: `env real > perfil > .env > config.json > defaults`.
- El `.env` del repo queda para lo específico del proyecto; `*.env` está en denyGlobs
  del rol `security` (gate bloqueante) y en los gates por defecto del loop.
- Para clientes MCP (Claude Code, Codex, Antigravity, OpenCode): las keys viven **en el
  server** — un host puede disparar `synthesize`/`run_agent` ejecutados por el modelo
  del harness sin poseer ninguna key propia.

## Verificación

```bash
aitl models          # backends configurados, activo y cadena de fallback
aitl models --detect # además persiste el modelo autodetectado de LM Studio
```

La tool MCP `synthesize` acepta `provider: auto | anthropic | openrouter | lmstudio |
openai-compat | extractive` para elegir el backend **por invocación** (p. ej. sintetizar
con un modelo barato aunque el activo sea otro).
