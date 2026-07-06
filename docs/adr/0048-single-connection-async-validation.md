# ADR-0048 — Conexión Mongo única con Mongoose como dueño + validación async en factories

- **Status:** Accepted
- **Date:** 2026-07-06

## Context
Quedaban dos conexiones descoordinadas tras retirar el checkpointer (ADR-0047): el
driver crudo (`db/client.ts`, `connectWithFallback` con `_activeUri` propio) y
Mongoose (`db/mongoose.ts`, otra lógica primary→fallback y otro `_activeUri`) —
podían acabar en URIs distintos si uno hacía fallback y el otro no. Además, Mongoose
9 deprecó `Document.validateSync()` ("will be removed in Mongoose 10; use
`validate()`") sin alternativa síncrona pública; las 15 factories `makeX()` lo
usaban, y `util/quiet.ts` lo silenciaba con un monkeypatch de `process.emitWarning`
que tragaba TODAS las deprecations.

## Decision
1. **Mongoose dueño único de la conexión**: el fallback primary→fallback vive SOLO
   en `db/mongoose.ts` (`redactMongoUri`/`activeUri`/`candidateUris` se mueven ahí);
   `db/client.ts` queda como capa de compatibilidad — `getClient()`/`getDb()`
   devuelven el MongoClient/Db subyacente de Mongoose, `connectWithFallback` delega
   en `connectMongoose`, `closeClient()` = `disconnectMongoose()`. Firmas públicas
   intactas; `getDb()` sigue sync pero ya NO autoconecta: lanza con mensaje claro si
   no hay conexión (los llamadores eager hacen ensure primero). `migrate/atlas.ts`
   conserva a propósito sus clientes propios src/dst con cierre en `finally`.
2. **Las 15 factories `makeX()` pasan a async** con `await doc.validate()`; ~35
   call sites actualizados (callbacks `onDecision`/`onRetry`/`onHookEvent` aceptan
   Promise; `RepoMap` usa `Promise.all`).
3. **`util/quiet.ts` borrado**; tras el retiro, stderr quedó vacío en
   models/search/check-db — no tapaba ningún otro warning real.

## Consequences
- Una sola conexión que abrir y cerrar: search/models/check-db terminan solos
  (~2s), sin fugas; imposible divergencia de URI entre capas.
- Deuda de ADR-0036 saldada (los "dos pools" y validateSync eran sus consecuencias
  registradas; el ADR histórico queda intacto).
- Cambio de contrato: código nuevo que llame `getDb()` "en frío" falla rápido con
  mensaje claro en vez de autoconectar implícitamente.
- Las deprecations vuelven a ser visibles (sin monkeypatch); `makeX()` async es el
  patrón para modelos futuros.
- verify 118/118, typecheck y build limpios; E2E por la ruta única contra Atlas
  verificado.
