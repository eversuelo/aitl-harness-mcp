---
name: limpieza-catalogo-raytracer-2026-07-12
description: >-
  Limpieza del workspace 2026-07-12 (cerrada): softwares raytracer fusionados,
  projects re-intentados agrupados bajo "raytracer", conocimiento sintetizado,
  project demo borrado (12 memorias); el software duplicado "Ray Tracer
  Learning" se conserva por decisión del usuario.
type: project
category: decision
tags:
  - catalogo
  - workspace
  - limpieza
  - raytracer
version: 2
updated_at: 2026-07-12T03:55:17.044Z
branch: feat/harness-v2
commit_sha: 6dc1d507a01fa6591dbc592725406bc9ca33bcc9
---
Limpieza del catálogo (2026-07-12, sesión de las tools get/update/delete_memory — ADR-0074). CERRADA: el usuario decidió «solo re-acomoda las memorias y borra demo».

1. **Softwares duplicados fusionados**: "Ray Tracer Learning" (creado 2026-07-12 con descripción) y "ray-tracer-learning" (creado 2026-07-11 vacío) apuntaban ambos al project `ray-tracer-learning`. Se consolidó en el kebab `ray-tracer-learning` (convención del catálogo: name kebab + display_name bonito), con description y tags absorbidos. La entrada "Ray Tracer Learning" SE CONSERVA por decisión del usuario (borrable después con delete_software si estorba en el árbol Workspace).
2. **Projects re-intentados agrupados**: `aitl-raytracer-orq`, `aitl-raytracer-orq-sonnet` y `aitl-raytracer-spec-sonnet` (corridas del orquestador sobre metricas/raytracer/start, rama curso) estaban "sin software"; ahora son members de software `raytracer` (Raytracer Lab) junto a `aitl-raytracer`.
3. **Conocimiento sintetizado**: `synthesize --compact` (extractivo; ver [[provider-chutes-404-en-synthesize]]) sobre aitl-raytracer-orq-sonnet (27 docs → 2 síntesis, 42KB→3.4KB) y aitl-raytracer-orq (3 docs → 1). Además una síntesis CURADA a mano: memoria `consolidado-experimento-orquestador-sonnet` en aitl-raytracer-orq-sonnet con los resultados por fase 00-07 y las 5 lecciones operativas del patrón de delegación (el orquestador nunca edita a mano, base limpia por fase, sin background headless, rebuild forzado anti-falso-positivo, presupuesto de 3 fixes).
4. **Ledger saneado**: ids malformados `0036-mongoose-data-layer` y `0037-branch-aware-repomap` (un adr-sync del 2026-07-06 usó nombres de archivo como id) → deprecated con superseded_by 0036/0037. Serie canónica 0001-0074.
5. **Project demo BORRADO** (2026-07-12, a petición explícita): 12 memorias de prueba SDD del 2026-07-02 (specs/design/tasks del CSV-export ficticio + 2 session summaries) eliminadas de la colección `memory`; `memory_history` intacta.
