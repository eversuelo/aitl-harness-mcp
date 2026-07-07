# ADR-0025 — graphify desacoplado en módulo puro tras un port GraphSource

- **Status:** accepted
- **Date:** 2026-06-28

## Context

graphify vivía dentro del MCP server (mcpserver/server.ts) mezclando tres responsabilidades: fetch a Mongo, transformación a nodos/edges, y serialización DOT. No era testeable sin DB ni reutilizable por la HTTP API/UI.

## Decision

Extraer src/graph/: núcleo PURO (build.ts builders, serialize.ts), tipos (types.ts) y un port GraphSource (source.ts) con adaptador MongoGraphSource (único borde impuro). graphify() orquesta fetch→build sin serializar. El MCP tool conserva su contrato (JSON/DOT byte-identical), preservando paridad con server.py.

## Consequences

Builders/serializadores testeables sin Mongo (6 tests, 23 en suite). Reutilizable por HTTP API/UI (E7) y habilita el inverso (de-graphify) hacia un KnowledgeCodec. Tercer eje de agnosticismo (representación) modelado como port, igual que Provider y el propuesto ContextCompressor (EVAL-2).
