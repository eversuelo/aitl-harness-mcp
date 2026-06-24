# ADR-0002 — Use MongoDB Atlas Vector Search as the single durable store

- **Status:** Accepted
- **Date:** 2026-06-13

## Context
The harness needs both structured documents (runs, messages, memory, decisions, symbols) and
semantic search over memory + chats. A common reflex is to add a dedicated vector DB
(Qdrant/Chroma/Pinecone) next to a primary DB. The thesis must run **locally first** but stay
**portable to cloud** with no code changes.

## Decision
Use **MongoDB with Atlas Vector Search** as the *only* datastore. Embeddings are stored inside the
same documents and queried with the `$vectorSearch` aggregation stage (`src/memory/store.ts`,
`src/db/indexes.ts`). For local development we run the **`mongodb/mongodb-atlas-local`** Docker
image, which includes Atlas Search + Vector Search and exposes the **same `$vectorSearch` API** as
MongoDB Atlas in the cloud. Switching to cloud is a one-line change of `MONGODB_URI`.

Embeddings default to **`Xenova/all-MiniLM-L6-v2` (384 dims, local, no API key)** via
`@xenova/transformers`; **Voyage voyage-3 (1024 dims)** is an opt-in alternative. The vector index
`numDimensions` (`EMBEDDING_DIMS`) must match the active embedder.

## Consequences
- One source of truth: no sync between a document DB and a separate vector DB.
- Identical query surface in local and cloud → reproducible thesis experiments.
- Coupling to MongoDB's vector search semantics; mitigated by isolating all DB access behind
  `src/memory/store.ts` and `src/db/`.
- Changing the embedding model requires recreating the vector index and re-embedding documents.
