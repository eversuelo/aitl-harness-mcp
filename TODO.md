# TODO — Anti-regresión de ADRs por módulo

Objetivo: que al diseñar o implementar un módulo se sumaricen las ADRs que lo
restringen, para que el desarrollo no contradiga decisiones previas (*decision amnesia*).

**Causa raíz:** hoy `hydrate` filtra las ADRs solo por `project` y cae a recencia
(`renderDecisions`, `src/memory/lifecycle.ts`), así que puede omitir justo la ADR que
restringe el módulo en curso. Las ADRs no tienen scope de componente: `record_decision`
no expone `tags`/`components`.

---

## 1. Dar scope de componente a las ADRs  *(base — desbloquea 2 y 3)*

- [ ] Añadir `components: string[]` al schema de `decisions` (`src/memory/schemas.ts`).
- [ ] Exponerlo en el CLI/MCP `record_decision`.
- [ ] Backfill de las 23 ADRs existentes con sus componentes (`src/providers`, `src/orchestration`, …).
- [ ] Registrar como **ADR-0024**.

> Con la recall semántica en español débil hasta el índice vectorial de Atlas (ADR-0010),
> el match exacto por tag es lo fiable hoy → esta capa es tag-based, no semántica.

## 2. Comando `aitl module-brief <dir|nombre>`  *(bloqueada por #1)*

- [ ] Jalar las ADRs + memoria-de-componente ligadas a un módulo (vía el campo `components`).
- [ ] Renderizar como **checklist de invariantes** (haz/no hagas), no texto crudo: reducir
      cada ADR a su decisión + consecuencia.
- [ ] Reusar `relevant()` (`src/memory/lifecycle.ts`) filtrado por tag.
- [ ] Opción: exponerlo también como sección extra de `hydrate --component`.

Ejemplo de salida:

```
## Invariantes de src/providers (NO romper sin nueva ADR)
- [ADR-0019] Todo gateway OpenAI-compatible reusa OpenAIProvider — no crear clientes nuevos.
- [ADR-0020] Único provider de modelo = OpenRouter; Gemini/OpenAI/Anthropic crudos eliminados.
- [ADR-0005] chatStream() es opcional y aditivo — no romper el fallback a chat().
```

## 3. Guardia de regresión sobre el diff  *(bloqueada por #1)*

> La parte que de verdad **previene** regresión; las capas 1-2 solo informan.

- [ ] Sobre el diff: archivos cambiados → ADRs ligadas a esos componentes →
      "¿este cambio contradice alguna ADR?".
- [ ] Con LLM = check real; rules-first = re-imprimir las ADRs vinculadas como recordatorio
      antes de que el edit aterrice.
- [ ] Cablear como hook `PreToolUse` en Edit/Write, o mejor un `pre-commit` / pre-PR.
