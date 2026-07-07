# ADR-0057 — Documentación consolidada: un canónico de arquitectura y un attic para lo histórico

- **Status:** accepted
- **Date:** 2026-07-07
- **Components:** docs

## Context

Convivían dos documentos de arquitectura solapados y con deriva: docs/ARQUITECTURA.md (español, conceptual, con diagramas anclados a ADRs pero congelado antes del ciclo v2: aún describía LangGraph, `aitl eval` y una «TUI Ink» como panel) y docs/ARQUITECTURA-AITL-JS.md (inglés, formato auditoría, cuyo análisis de brechas —«faltan tests, falta streaming, LangGraph opcional»— quedó resuelto o superado por los ADRs 0043–0056). Además, docs/thesis/* y docs/sessions/* duplicaban historia que hoy vive en el almacén durable (prompt-log, memorias de sesión, ledger de decisiones), y los índices de ADRs mantenidos a mano (docs/README.md, docs/adr/README.md) quedaron obsoletos por diseño desde que el espejo markdown es completo y bidireccional (ADR-0051).

## Decision

1. **Un solo canónico**: docs/ARQUITECTURA.md es EL documento de arquitectura. Se actualizó al estado post-ADR-0056: stack sin LangGraph (loop propio `runAgent`, ADR-0047) y con Mongoose como capa de datos (ADR-0036); mapa de componentes con council/coord/sdd y el panel readline con su rama Task; nueva sección «El ciclo harness-v2 (ADRs 0046–0056)» con la tabla capacidad→ADR→código; superficie CLI/MCP al día (incluye coord, council, sdd, sync, module-brief; retira `eval`); evaluación DSR vía `run --bare` (C0) vs default (C2); invariantes ampliados con degradación explícita (ADR-0052) y confirm-before-persist en superficies interactivas (ADR-0056); índice de símbolos sin buildGraph/EvalRunner y con los módulos nuevos.
2. **Attic**: docs/attic/ recibe lo histórico —ARQUITECTURA-AITL-JS.md, docs/thesis/*, docs/sessions/*— con un README que declara que nada ahí es vigente y apunta al canónico y al almacén durable.
3. **Índices que no se pudren**: docs/adr/README.md deja de mantener una tabla a mano; declara que el directorio es espejo COMPLETO del ledger (contiguo 0001–0056+) mantenido por `aitl sync --project aitl-js`, que los nombres de archivo llevan id+título, y que el estado del ledger (incluido el next free) se rastrea en CLAUDE.md. docs/README.md apunta al canónico y al attic.

## Consequences

- Un único lugar donde leer la arquitectura vigente; la deriva entre documentos desaparece como categoría de problema (el segundo documento ya no existe como par).
- La historia sigue siendo descubrible (git + attic) pero está claramente marcada como no vigente; la historia viva es el almacén durable, como sostiene la tesis.
- Los índices de ADRs ya no pueden quedar desincronizados: el espejo los sustituye.
- Costo aceptado: docs/ARQUITECTURA.md concentra la responsabilidad de mantenerse al día; la convención por fase (ADR + espejo + ledger en CLAUDE.md) es el mecanismo que lo sostiene.
