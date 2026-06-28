# ADR-0029 — Knowledge map multi-entidad (graphify extendido + pestaña UI)

## Status

accepted

## Context

El tab Graph del UI solo proyectaba `symbols` + `memory`. La tesis necesita una imagen
de trazabilidad que abarque la jerarquía `software → projects → repos` y los artefactos
durables (`memory`, `decisions`, `context`). La infra de grafo ya estaba desacoplada
(`src/graph/` puro tras ADR-0025) con `GraphSource` y un force-layout sin librerías en
el web.

## Decision

Extensión **aditiva** del módulo de grafo (sin tocar `graphify` ni el tab Graph
existente):

- `types.ts`: `NodeKind` ahora incluye `decision|context|software|project|repo`
  (además de `symbol|memory`); `EdgeKind` incluye `contains|references`; nuevas filas
  `DecisionRow/ContextRow/SoftwareRow/RepoRow`.
- `GraphSource` gana `decisions/context/softwares/repos`; `MongoGraphSource` las
  implementa.
- Nuevo builder puro `src/graph/knowledge.ts`: `buildKnowledgeGraph` arma un grafo
  por-proyecto con nodos de entidad y edges de jerarquía (software→project,
  project→repo, repo/project→{memory,decision,context,symbol}) reusando
  `buildMemoryGraph`/`buildSymbolGraph` para los edges `link`/`ref`, más edges
  `references` parseando `[[ADR-xxxx]]`/`[[slug]]` del texto de las ADRs. El sub-scope
  `repo` decide el padre (repo si lo tiene; si no, project).
- Orquestador `knowledgeGraphify(source, {project, entities})` que sólo fetchea las
  colecciones de los kinds pedidos (`symbol` excluido por defecto por volumen).
- API `GET /api/knowledge-graph?project=&entities=`.
- Web: `api.knowledgeGraph` + pestaña **Knowledge Map** que reusa `computeLayout`, con
  chips de filtro por tipo de entidad (refetch al togglear), colores por kind, edges
  `contains`/`references` diferenciados (dash) y panel de detalle al click.

## Consequences

- Vista de trazabilidad `software → project → repo → {memory, decision, context}` con
  cross-links de referencias. El tab Graph antiguo queda intacto (`graphify` sin
  cambios).
- Symbols opcionales (off por defecto; en el tab Graph para detalle).
- El grafo es por-proyecto (la jerarquía se ancla al project seleccionado).
- Verificado: typecheck/build backend (33 tests) y web; live contra Atlas dio node
  kinds `{project,repo,software,memory,decision}` y edges `{contains:4, references:1}`.
- **Diseño (DSR):** visualizar procedencia como grafo dirigido navegable (no log plano)
  hace evaluable y enseñable la trazabilidad; extender el puerto `GraphSource` y los
  builders puros mantiene el núcleo testeable sin DB.
- Fuera de alcance: layout jerárquico dedicado (se usó force plano con filtros) y
  timeline/diff viewer.
