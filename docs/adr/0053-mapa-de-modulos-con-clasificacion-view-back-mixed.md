# ADR-0053 — Mapa de módulos con clasificación view/back/mixed/infra y module-brief: invariantes por directorio desde ADRs etiquetados y memoria de componentes

- **Status:** accepted
- **Date:** 2026-07-06

## Context

El repomap agrupaba por archivo y era branch-aware, pero no ofrecía una vista por módulos (directorios principales) ni distinguía frontend/backend — pedido explícito del usuario para orientar a agentes y humanos en repos nuevos. Complemento del TODO histórico "decision amnesia": los ADRs ya tienen components[] (P3) y capture-session etiqueta memoria con component:<dir>, pero nada los cruzaba en una vista por módulo. Problema práctico detectado: en repos con todo bajo src/, un mapa de primer nivel da un solo módulo inútil (126 archivos).

## Decision

(1) src/repomap/modules.ts: classifyModuleKind PURA — extensiones view (.tsx/.jsx/.css/.html/.vue/.svelte) y segmentos de ruta (web/ui/frontend/views/components → view; server/db/models/api/backend → back; scripts//dot-dirs/(root) → infra), umbral 70% para decidir lado, mixed si no domina; override declarativo .aitl/modules.json que gana siempre y nunca lanza. (2) aggregateModules por directorio de PRIMER nivel (archivos raíz → "(root)"; top-5 símbolos por pagerank; orden por symbols desc) con DESCENSO de un nivel cuando un dir domina (>80% de archivos y tiene subdirs): src/ → 37 módulos legibles; archivos sueltos del dominante quedan en su módulo propio. Mismo filtro branch-aware y aviso de staleness que RepoMap.render. (3) module-brief <dir>: bloque del módulo + ADRs cuyo components[] intersecta el dir (match por segmentos completos en ambos sentidos, nunca por substring; excluye INACTIVE_ADR_STATUSES) + memorias con tag component:<dir>; si no hay nada etiquetado, sugiere cómo etiquetar — es el checklist de invariantes por módulo del TODO. (4) Superficies: aitl repomap --modules [--json], aitl module-brief <dir>, tools MCP read-only get_module_map/get_module_brief.

## Consequences

- Orientación instantánea en un repo: qué módulos hay, cuáles son vista/backend/infra, qué símbolos pesan — y por módulo, qué decisiones lo restringen y qué memoria lo menciona (anti "decision amnesia" operativo).
- verify 206/206 (23 tests nuevos DB-free). E2E aitl-js: web→view, src/server→back, scripts→infra; module-brief src/server listó 3 memorias reales de capture-session y el hint de etiquetado para ADRs.
- Deuda: el server MCP en ejecución es build viejo (reiniciar para exponer las tools nuevas y el components de P3); snapshot legado repo:null en symbols de aitl-js suprime el descenso sin --repo (limpieza de datos pendiente); lista de memorias del brief sin tope (capar a N si crece).
- Los módulos TUI (src/interactive, src/repl) clasifican back por defecto — el override .aitl/modules.json cubre el matiz si importa.
