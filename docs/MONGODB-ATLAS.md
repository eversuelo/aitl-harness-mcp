# MongoDB Atlas connection

AITL-Harness-JS uses the same MongoDB driver code for local `mongodb-atlas-local` and cloud Atlas.
Only `MONGODB_URI` changes. This is the operational companion to ADR-0002.

## 1. Create the local env file

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace `MONGODB_URI` with the Atlas SRV connection string:

```dotenv
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster-host>/<database>?retryWrites=true&w=majority&appName=aitl-harness
MONGODB_DB=aitl
```

Do not commit `.env`.

## 2. Atlas prerequisites

- Database user exists and has `readWrite` on `MONGODB_DB`.
- Atlas Network Access allows your current IP address.
- The cluster tier supports Atlas Search / Vector Search.
- `EMBEDDING_DIMS` matches the active embedder and vector index. Default local embeddings use `384`.

## 3. Verify credentials and network access

```powershell
npm run check-db
```

Expected output redacts credentials:

```text
MongoDB ping OK: mongodb+srv://<credentials>@<cluster-host>/<database>?... (db=aitl)
Server version: ...
```

## 4. Create collections and indexes

After `check-db` passes:

```powershell
npm run init-db
```

This creates collections, scalar/text indexes, and the `vector_index` Atlas Vector Search indexes for
`messages`, `memory`, and `decisions`.

## Troubleshooting

| Symptom | Likely fix |
|---|---|
| `Server selection timed out` | Check Atlas Network Access and the cluster hostname. |
| `bad auth` / authentication failed | Check username, password URL-encoding, and database user permissions. |
| Vector index creation fails | Use Atlas or `mongodb/mongodb-atlas-local`; plain `mongod` does not provide Vector Search. |
| Vector search returns no results | Wait until Atlas Search indexes are `READY`, then ingest documents again if needed. |
