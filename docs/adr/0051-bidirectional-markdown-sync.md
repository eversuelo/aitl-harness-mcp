# ADR-0051 — Sync markdown bidireccional: espejo legible en .aitl/ y docs/adr/

- **Status:** Accepted
- **Date:** 2026-07-06

## Context
El estado durable (memoria, ADRs, skills, agents) solo era importable disco→Mongo
(ingest, adr-sync) y exportable a formatos de IDE; no había espejo markdown legible
ni round-trip. Consecuencias: `docs/adr/` incompleto (faltaban 0010-0025, 0032-0035,
0043-0045), el conocimiento no era editable con un editor de texto, y sin LLM/host el
contenido de Mongo era opaco. Restricción dura: `docs/adr/` contiene prosa manuscrita
cuidada que un sync ingenuo (comparar disco vs Mongo) sobreescribiría o marcaría en
conflicto para siempre.

## Decision
1. **Dir canónico dividido**: ADRs → `docs/adr/NNNN-slug.md` (formato manuscrito
   existente; `parseAdrMarkdown` extendido a los campos de lifecycle y variantes
   legadas) y memoria/skills/agents → `.aitl/{memory,skills,agents}/<slug>.md` con
   frontmatter YAML que `parseMarkdownFile` ya entiende (version/commit_sha/branch;
   roles con `metadata.kind: role`). Renderers puros deterministas; embedding nunca
   se exporta; tipos reservados excluidos por default (`--include-reserved`).
2. **Manifiesto de dos hashes** (`.aitl/.sync-state.json`: diskHash + mongoHash):
   «cambió» significa cambió respecto a la línea base de ESE lado — la prosa
   manuscrita y el render canónico conviven sin ruido.
3. **Motor de tres estados**: solo-Mongo → escribe disco; solo-disco → upsert por el
   pipeline real (versionado append-only); ambos → conflicto reportado sin tocar
   (exit 2), salvo `--pull`/`--push`. Bootstrap: presente en ambos lados sin línea
   base → sembrar sin escribir; solo los ausentes se propagan. Borrados nunca se
   propagan.
4. **Superficies**: `aitl sync [--pull|--push]`; `export --adapter markdown`;
   `adr-sync` intacto (push-only). Solo ids numéricos de ADR se espejan; prefijos
   ambiguos congelan el id. `.gitignore` solo para `.sync-state.json`.

## Consequences
- `docs/adr/` completo 0001-0050 (23 backfilled) con CERO manuscritos modificados;
  `.aitl/` nace con 35 memorias + 2 skills + 5 agents; corridas 2-3 = no-op.
- El conocimiento es editable con cualquier editor: editar el md y `sync --push`
  bumpea versión con historia. El modo memoria pura gana superficie de trabajo.
- verify 176/176 (19 tests nuevos). Hallazgo: 2 docs legados en Mongo con id
  malformado (`0036-mongoose-data-layer`, `0037-branch-aware-repomap`) — solo se
  reportan; decidir si se eliminan.
- Deuda: frontmatter arbitrario no se re-exporta; definiciones usan `updated_at` en
  el manifiesto; sin merge automático por diseño.
