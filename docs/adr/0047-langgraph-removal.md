# ADR-0047 — Retiro de LangGraph: runAgent como loop único, resumible desde el transcript durable

- **Status:** Accepted
- **Date:** 2026-07-06

## Context
`buildGraph` (orchestration/graph.ts) cableaba el mismo loop como `StateGraph` de
LangGraph con `MongoDBSaver`, pero era un segundo loop muerto: su único uso era el
re-export en `src/index.ts`, sin gates, sin maxIters, y su checkpointer creaba un
tercer `MongoClient` propio sin fallback ni cierre (fuga de conexión). La auditoría
2026-07-05 lo marcó como tensión: "dos loops — cablear o borrar". Mantenerlo obligaba
a portar gates/roles/verify a la variante de grafo o aceptar divergencia permanente
del loop real.

## Decision
Borrar en vez de cablear: se eliminan `buildGraph`,
`src/orchestration/checkpointer.ts` y las deps `@langchain/langgraph` +
`@langchain/langgraph-checkpoint-mongodb`. `runAgent` queda como loop único; la
reanudación no necesita checkpointer externo porque el transcript
(runs/messages/events) ya es durable en Mongo — el estado del loop ES el estado
persistido. Se limpian re-exports (`index.ts`), `util/optional.ts`, `Functions.md`,
`CLAUDE.md` (Stack) y `src/README.md`. Bonus del retiro: `npm ls` queda con UN
driver mongodb deduplicado (mongoose 9.7.3 empaqueta ~7.2; se alineó la dep directa
6→7).

## Consequences
- Desaparece la tercera conexión Mongo sin cierre (parte del hallazgo Media de la
  auditoría).
- Cero referencias langgraph/buildGraph/checkpointer en `src/`, `scripts/` y `web/`;
  verify 118/118; build limpio.
- Narrativa metodológica honesta para la tesis (chapter-03): LangGraph se evaluó
  como checkpointer opcional y se retiró porque un loop propio sobre estado durable
  propio lo hace redundante.
- Topologías de grafo arbitrarias quedan fuera del alcance; si se necesitaran, se
  reevaluaría con un ADR nuevo.
- Riesgo aceptado: bump del driver mongodb 6→7 (superficie usada sin cambios, suite
  verde).
