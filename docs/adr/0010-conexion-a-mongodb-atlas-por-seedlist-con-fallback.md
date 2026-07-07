# ADR-0010 — Conexión a MongoDB Atlas por seedlist con fallback

- **Status:** accepted
- **Date:** 2026-06-24

## Context

Complementa [ADR-0002] (Mongo Atlas como único store) y [ADR-0009] (migrate-atlas). El harness debe correr en runtime contra Atlas (no solo Mongo local en :27018). Al invocar el CLI fuera de AITL-Harness-JS/, el .env no se carga y aitl cae al default :27017. La búsqueda léxica del harness requería un índice $text en memory que no existía en Atlas.

## Decision

Conectar a Atlas por seedlist explícita con connectWithFallback. La lectura de memoria usa una cascada robusta vector → texto → recencia. Se creó el índice $text de la colección memory en Atlas durante la verificación de la Fase A. El índice vectorial sigue pendiente (P1 del TODO: init-db completo contra Atlas, ver [ADR-0009]).

## Consequences

vectorSearch cae a textSearch hasta que init-db cree el índice vectorial en Atlas; conviene exportar MONGODB_URI=:27018 al correr el CLI desde fuera de AITL-Harness-JS/. La búsqueda semántica no está habilitada end-to-end hasta completar init-db. (Renumerado desde un 0001 escrito por error bajo la clave AITL-Harness-JS; ver memoria project-identity.)
