# ADR-0027 — Versionamiento append-only de ADRs y memoria (colecciones `_history`)

## Status

accepted

## Context

Los ADRs (`decisions`) y la memoria (`memory`) se sobrescribían en sitio vía
`updateOne(..., {$set}, {upsert:true})` por su clave natural (`project+id` /
`project+slug`), **sin guardar historial**. El tool `list_decisions` ya prometía
"versioned ADRs" pero no había versionamiento. Para la tesis (procedencia y
reproducibilidad) hace falta ver cómo evolucionó una decisión o una nota y quién la
cambió, sin romper las lecturas actuales ni los índices únicos vivos. El proyecto ya
usa el patrón append-only en `prompts`, `mcp_context` y `audit`.

## Decision

Versionamiento append-only mediante colecciones hermanas `decisions_history` y
`memory_history`.

- Se añadió `version: int` (default 1) y `actor_id` / `actor_role` a `ADRSchema` y
  `MemoryDocSchema`. **Las claves únicas vivas NO cambian.**
- Nuevo helper `src/memory/versioning.ts`:
  - `contentChanged()` compara solo campos significativos (ADR:
    title/context/decision/consequences/status; memoria:
    description/body/type/tags/links/category) → idempotencia de `adr-sync`.
  - `archiveAndBumpVersion()` corre **antes** del overwrite: si el doc existe y
    cambió, snapshotea el previo (sin embedding) en `*_history` atribuido a **su
    autor** (el `actor_id` del previo) y sube `version+1`; si no cambió, conserva
    versión y autoría; si no existe, `version=1`.
- Cableado en `ADRStore.upsert` y `MemoryStore.upsertMemory` con un parámetro `actor`
  opcional, pasado desde MCP (`mcpActor`), CLI (`CLI_ACTOR`) y HTTP (`resolveActor`).
- Índices únicos `{project, ref, version:-1}` en cada `*_history`.
- Superficie de lectura (read-only, **no** en `TOOL_RBAC`):
  - MCP: `list_decision_versions`, `get_decision_version`, `list_memory_versions`,
    `get_memory_version`.
  - CLI: `aitl adr history <id>` / `aitl memory history <slug>` con `--diff` (diff por
    campo + diff de líneas LCS; helper sin dependencias en `src/util/diff.ts`).
  - Loader reusable `src/memory/history.ts` (`loadVersionChain`).

## Consequences

- Cada cambio real queda como versión consultable y diffeable; las lecturas vivas
  (`list_decisions`, `search_memory`, `/api`) no cambian.
- **Sin migración**: docs sin `version` se leen como 1 y al primer cambio se archivan
  como v1.
- Autoría **por versión** (el snapshot se atribuye a su autor, no a quien lo
  supersede).
- Idempotencia: re-correr `adr-sync` sobre los mismos `.md` no crea versiones
  espurias.
- El historial crece append-only (poda/retención fuera de alcance). Rollback no
  incluido (lectura/diff solamente).
- Verificado end-to-end contra Atlas: write ×3 (1 sin cambio) deja `history=1` y live
  `version=2`; CLI `history` y `--diff` muestran autoría y diff de líneas. Tests en
  `src/memory/versioning.test.ts`.
- **Diseño (DSR):** separar el estado vivo de la historia de revisiones da un grafo de
  procedencia sin tocar el contrato de lectura ni los índices únicos vivos.
