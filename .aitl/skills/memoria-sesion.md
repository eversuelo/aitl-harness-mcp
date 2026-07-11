---
name: memoria-sesion
description: >-
  Cierra una sesión de trabajo grabando CADA aprendizaje en el MCP aitl-js: una
  memoria por hallazgo, ADR si hubo decisión (next-free verificado),
  record_prompt del prompt conductor, aitl sync --pull para espejar, y
  verificación del recall. Lo que no se escribe en el MCP no existe.
tags:
  - meta
  - memoria
  - sesion
  - cierre
  - adr
updated_at: 2026-07-11T23:30:01.883Z
---
# Memoria de sesión — grabar cada aprendizaje

Disciplina de cierre: convertir lo aprendido en estado durable, consultable por
`search_memory` y `hydrate` en la próxima sesión.

## Checklist de cierre (en orden)

1. **Un hallazgo = una memoria.** Por cada aprendizaje real (bug, gotcha, decisión,
   estado de avance): `write_memory { project: "aitl-js", slug, body, description,
   type, tags, links }`.
   - `slug` estable en kebab-case (`hallazgo-router-budget-2026-07-11`), pensado para upsert.
   - `type`: `project` (avance/estado) · `reference` (hallazgo consultable) ·
     `feedback` (corrección del usuario) · `user` (quién es / preferencias).
   - `tags`: `session-YYYY-MM-DD`, `component:<dir>` por cada directorio tocado.
   - `links`: `[[slug]]` a memorias relacionadas — teje el grafo.
   - Fechas SIEMPRE absolutas (nunca "ayer", "la semana pasada").
2. **¿Hubo decisión arquitectónica?** → ADR con `record_decision`.
   - ANTES: carga `adr-ledger-reconcile` (`project="__global__"`) y verifica el
     next-free real en la colección `decisions`. Nunca pinnees números en docs.
   - Un plan aún no ejecutado se registra con `status: "proposed"`.
3. **Registra el prompt que condujo el trabajo:** `record_prompt { project, prompt,
   title, tags }` — la sesión debe ser reconstruible.
4. **Espeja a disco:** `aitl sync --pull --project aitl-js` (actualiza `docs/adr/` y
   `.aitl/{memory,skills,agents}/`). Los archivos son el espejo; Mongo es la verdad.
5. **Verifica el recall:** `search_memory` con 2-3 términos del hallazgo debe devolver
   lo que acabas de escribir. Si no aparece, la descripción/tags son pobres: mejóralos.

## Anti-patrones (no hagas esto)

- Escribir UNA memoria gigante "resumen de todo" en vez de hallazgos enlazados.
- Duplicar: busca el slug antes (`search_memory`) y ACTUALIZA (upsert) si ya existe.
- Guardar lo que el repo ya registra (código, git history, CLAUDE.md) — guarda lo NO derivable.
- Registrar el ADR sin verificar el next-free (rompe la contigüidad del ledger).
- Cerrar la sesión con trabajo sin commitear y no dejar memoria de QUÉ quedó pendiente.

## Qué merece memoria (criterio)

| Aprendizaje | ¿Memoria? | Tipo |
|---|---|---|
| Bug con causa raíz no obvia + fix | Sí | `project` (categoría bug) |
| Decisión de diseño con alternativas | ADR (+ memoria si tiene matices) | `record_decision` |
| Estado de avance de una campaña/experimento | Sí | `project` |
| Preferencia o corrección del usuario | Sí | `feedback` |
| Comando/receta que costó descubrir | Sí | `reference` |
| Detalle que solo importa a ESTA conversación | No | — |
