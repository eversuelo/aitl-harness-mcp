---
name: session-2026-07-12-memoria-repomap-ola6
description: >-
  Estado final sesión 2026-07-12 (rama feat/harness-v2, SIN commit): ADR-0074
  (get/update/delete_memory + repomap F1), fix capture-session runs vacíos,
  limpieza de catálogo + síntesis raytracer, Ola 6 de specs (M01-M05) + 19 ADRs
  SPEC-* + PROMPT-EJECUCION.md en ray-tracer-learning. Pendientes: commit del
  working tree, Chutes 404, restart del MCP server.
type: project
category: task
tags:
  - session
  - estado-final
  - adr-0074
  - repomap-v2
  - ola-6
version: 1
updated_at: 2026-07-12T04:54:55.203Z
branch: feat/harness-v2
commit_sha: f84b9037494c6e7c0f11c99c498e3169eb62b6ae
---
SESIÓN 2026-07-11/12 cerrada (Claude Code, rama `feat/harness-v2`, run 3d2ebb48). Verify final: **455/455**. ⚠️ TODO el trabajo está en el WORKING TREE SIN COMMITEAR (en ambos repos) — primer paso de la próxima sesión: revisar `git status` y commitear.

== HARNESS (AITL-Harness-JS) ==
1. **ADR-0074** (accepted): tools MCP `get_memory`/`update_memory`/`delete_memory` (55→58; RBAC memory:update/delete, canario a 29 mutantes) + **repo map v2 F1**: parser scope-aware (SymbolDef con line_start/end, parent, exported, signature, doc-comment; kinds method/property; constructor excluido; properties fuera del PageRank), modelo Symbol extendido aditivo, build() incremental (prune de archivos borrados, rewrite solo mtime cambiado, bulkWrite de pagerank) con `lastStats`, CLI `repomap --full`. Mapa vivo reconstruido: 1393 símbolos, 154 methods nuevos, 362 funciones con doc. Detalle en el ADR.
2. **Fix capture-session** (memoria [[capture-session-runs-vacios-fix]]): `findLatestTranscript` autodescubre `~/.claude/projects/<cwd-slug>/*.jsonl`; captura vacía ahora LANZA (allowEmpty opt-in); 5 runs de ceros borrados y re-captura real del run del orquestador raytracer (22.1M tokens). Tests nuevos src/context/capture.test.ts.
3. Functions.md §14 actualizado a 58 tools. Ledger: ids malformados 0036-*/0037-* deprecated con superseded_by; serie 0001-0074 contigua; **next free 0075**.
4. ⚠️ El MCP server en ejecución es build VIEJO: reiniciarlo para exponer las 3 tools nuevas.

== CATÁLOGO / CONOCIMIENTO ==
5. Softwares raytracer fusionados; projects re-intentados agrupados bajo `raytracer`; project `demo` borrado (12 memorias); síntesis extractiva + [[consolidado-experimento-orquestador-sonnet]] (detalle en [[limpieza-catalogo-raytracer-2026-07-12]]). El software duplicado "Ray Tracer Learning" SE CONSERVA por decisión del usuario.
6. **Chutes 404** pendiente ([[provider-chutes-404-en-synthesize]]): la cadena auto de providers muere en 404; revisar slot openai-compat y hacer que FallbackProvider degrade ante 404.

== RAY-TRACER-LEARNING (specs, sin commit) ==
7. **Ola 6** `specs/estudio/`: SPEC-M01 (mallas+OBJ+shaderball/ciclorama), M02 (conductor GGX iso+aniso, VNDF), M03 (softbox+ciclorama+film ACES), M04 (render final "ALUMINIUM material study" 1920×1080), M05 (OBJ externos robustos + render clay). Refs visuales en specs/estudio/ref/. Índice de specs/README.md actualizado + regla de coordinación claim_task obligatoria.
8. **19 specs subidas como ADRs `SPEC-*`** al project ray-tracer-learning (E accepted, B/I/M proposed); ids no numéricos a propósito (el ledger 0000-0016+0017 es de ADRs de implementación).
9. **specs/PROMPT-EJECUCION.md**: prompt del orquestador (olas 2→6, contrato del subagente con claim/release + write_memory por hallazgo VÍA MCP, renders offline cpu/vk-compute + tiempo real `rayo view`, synthesize al cierre).
10. Coordinación multi-harness EN USO: el commit 4507408 fue la consolidación de Ola 1 del orquestador paralelo bajo la identidad git del usuario; esta sesión usó claim_task/release_task/publish_event y dejó anunciada la Ola 6 en el bus.

== PRÓXIMA SESIÓN (orden sugerido) ==
(a) commit en ambos repos; (b) reiniciar MCP server; (c) arreglar Chutes/fallback-404; (d) lanzar el orquestador con PROMPT-EJECUCION.md; (e) filtrar rutas fuera del cwd en componentTags.
