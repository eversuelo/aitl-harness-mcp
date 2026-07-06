# ADR-0011 — Colecciones agents/skills nativas del harness

- **Status:** accepted
- **Date:** 2026-06-24

## Context

El plan de 4 pilares necesita agentes y skills como datos durables del proyecto, sin depender de Engram. Todo debe construirse sobre runAgent, MemoryStore y la orquestación LangGraph existentes.

## Decision

Dar de alta colecciones agents y skills en el backend (DefinitionStore, una clase para ambas, keyed por (project, name), búsqueda $text con fallback regex). La hidratación de runAgent las carga junto con la memoria relevante. El router de skills (Fase B, [ADR-0013]) detecta skills relevantes e inyecta su content en el system prompt.

## Consequences

Base para Fase B (router de skills, [ADR-0013]) y Fase C (sub-agentes con ContextManager fresco). No se introduce dependencia de Engram. (Renumerado desde un 0002 escrito por error bajo AITL-Harness-JS.)
