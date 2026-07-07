# ADR-0020 — Providers consolidados en OpenRouter + HostAdapters (harness sobre Codex/Claude Code/Antigravity)

- **Status:** accepted
- **Date:** 2026-06-24

## Context

El producto se posiciona como SISTEMA COGNITIVO DUAL (decision del usuario): Cara A = harness propio que corre agentes; Cara B = backend de contexto/memoria via MCP que potencia otros agentes. Tener providers de API cruda por modelo (Gemini, OpenAI, Anthropic) no encaja: para modelos crudos basta UN gateway, y la visión real es que el harness corra SOBRE hosts de agente (codex, claude-code, antigravity).

## Decision

(1) Eliminar los providers de modelo crudo Gemini/OpenAI/Anthropic (archivos gemini.ts y anthropic.ts borrados; openai.ts repurposed como cliente OpenAI-compatible genérico, settings-independiente, usado solo por OpenRouter). Único provider de modelo: OpenRouter. modelPrimary/secondary pasan de enum estricto a z.string() (un valor obsoleto no debe tumbar la carga de settings; getProvider da el error claro al usarlo). Settings/ENV de gemini/openai/anthropic eliminados de config.ts, config/store.ts y .env(.example). (2) Nuevo seam HostAdapter (src/hosts/base.ts): HostAdapter{runTask}, CliHostAdapter (spawn headless, prompt por stdin), HOST_SPECS para claude-code (claude -p), codex (codex exec -) y antigravity (agy run), overridables por AITL_HOST_CMD_<NAME>. runOnHost(prompt, project, {host}) (src/hosts/run.ts) envuelve al host con hidratación de contexto + persistencia (run role='host', transcript, eventos hydrate/spawn, estado). CLI: 'aitl run-host <task> --host'. Embeddings (local/voyage) intactos.

## Consequences

El harness queda alineado con la visión: corre agentes con OpenRouter (Cara A) y/o corre SOBRE hosts externos añadiéndoles memoria/contexto/telemetría durables (la capa cognitiva). Verificado: build+typecheck limpios; getProvider('openrouter') OK y gemini/openai/anthropic dan error claro; runOnHost con host falso (node echo) persiste run role=host + transcript + eventos, status done, 0 residuos. Los comandos por defecto de los hosts son provisionales (a confirmar al probar con los CLIs reales; overridables por env). Deps @google/genai y @anthropic-ai/sdk quedan sin uso en package.json (limpieza opcional).
