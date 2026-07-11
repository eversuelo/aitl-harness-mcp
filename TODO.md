# TODO — Anti-regresión de ADRs por módulo

> Estado 2026-07-07: las capas 1 y 2 quedaron CONSTRUIDAS (ADR-0049 `components[]` +
> ADR-0053 `module-brief`/mapa de módulos). Solo la capa 3 (guardia sobre el diff)
> sigue abierta.

Objetivo: que al diseñar o implementar un módulo se sumaricen las ADRs que lo
restringen, para que el desarrollo no contradiga decisiones previas (*decision amnesia*).

**Causa raíz (histórica):** `hydrate` filtraba las ADRs solo por `project` y caía a recencia
(`renderDecisions`, `src/memory/lifecycle.ts`), así que podía omitir justo la ADR que
restringe el módulo en curso.

---

## 1. Dar scope de componente a las ADRs  *(CERRADA — ADR-0049)*

- [x] `components: string[]` en el modelo de `decisions` (`src/models/decision.model.ts`).
- [x] Expuesto en CLI/MCP `record_decision` (+ `aitl adr deprecate` con lifecycle).
- [x] Backfill: los ADRs del ciclo v2 llevan `components`; los legados se completan al tocarlos.
- [x] Registrado como ADR propia (0049, junto con anclaje a commit y ciclo de vida).

> Con la recall semántica en español débil hasta el índice vectorial de Atlas (ADR-0010),
> el match exacto por tag es lo fiable hoy → esta capa es tag-based, no semántica.

## 2. Comando `aitl module-brief <dir|nombre>`  *(CERRADA — ADR-0053)*

- [x] ADRs ACTIVAS + memorias `component:<dir>` ligadas al módulo (prefix match por `components`).
- [x] Render como bloque de invariantes del módulo (decisión + consecuencia, no texto crudo).
- [x] Tools MCP `get_module_map` / `get_module_brief`; CLI `aitl module-brief <dir>`.
- [x] `repomap --modules` (view/back/mixed/infra con override `.aitl/modules.json`).

Ejemplo de salida:

```
## Invariantes de src/providers (NO romper sin nueva ADR)
- [ADR-0019] Todo gateway OpenAI-compatible reusa OpenAIProvider — no crear clientes nuevos.
- [ADR-0020, enmendada por ADR-0044] Providers crudos = anthropic|openrouter|lmstudio|openai-compat
  detrás de getProvider (+ FallbackProvider); no crear clientes ad-hoc fuera de src/providers.
- [ADR-0005] chatStream() es opcional y aditivo — no romper el fallback a chat().
```

## 3. Guardia de regresión sobre el diff  *(CERRADA — `src/hooks/adrGuard.ts`)*

> La parte que de verdad **previene** regresión; las capas 1-2 solo informan.

- [x] Sobre el diff: archivos cambiados → ADRs ligadas a esos componentes →
      recordatorio inyectado en el resultado del tool (rules-first).
- [x] Rules-first = re-imprimir las ADRs vinculadas como recordatorio
      **en el resultado** del `write_file`/`edit_file` (PostToolHook, ADR-0039).
- [x] Cableado en `runAgent` (`src/orchestration/graph.ts`) y `aitl chat`
      (`src/repl/chat.ts`). Best-effort (degrada sin Mongo).
- [ ] LLM-mode = check real "¿este cambio contradice la ADR?" (fase futura,
      requiere un pre-hook que invoque al modelo — deferred).
- [ ] Hook `pre-commit` / pre-PR con `aitl guard` CLI (fase futura, standalone).

