# ADR-0046 — Web session auth: opaque Mongo-backed tokens, 401/403 split, delegated web writes, CORS allowlist

- **Status:** Accepted
- **Date:** 2026-07-05

## Context
Audit 2026-07-05 (High finding): the web UI could not write memory. The web client
never sent `Authorization`; `resolveActor` returned `web:anonymous` (role `user`) and
the RBAC matrix only grants writes to `root`/`agent` (admin's cell is `"delegated"`),
so Save/Delete always returned 403. `AITL_WEB_TOKENS` (static env map) was the only
mechanism — no issuance, no revocation. CORS was `*` on every route.

## Decision
1. **Sessions collection** storing only the sha256 of an opaque 32-byte base64url
   token issued by `POST /api/auth/login` (verifies against `users` via pbkdf2
   `verifyUserCredentials`); TTL index on `expires_at` (7d default,
   `AITL_WEB_SESSION_TTL_MS` override), unique index on `token_hash`.
2. **`resolveActor` cascade** (now async): Mongo session → `AITL_WEB_TOKENS`
   (legacy compat) → anonymous.
3. **401/403 split in `guard()`**: unauthenticated callers get
   `401 {error:"login_required", hint:"POST /api/auth/login"}` so the UI can prompt;
   authenticated actors lacking the permission keep 403. Authenticated web writes
   pass `delegated: true` — the API server mediates the write under the same trust
   model as the MCP server's `guardTool`; without it the `admin="delegated"` cell
   still denied the UI after login.
4. **CORS allowlist** `AITL_WEB_ORIGINS` (CSV; defaults to the Vite dev/preview
   ports): reflect the Origin + `Vary: Origin` only when listed; otherwise no CORS
   headers at all.
5. **Web client**: token in `localStorage`, `Authorization` on every call,
   `UnauthorizedError` reopens the login dialog; logout revokes (deletes the session
   doc). API collaborators are injectable (`ApiDeps`) so tests run without Mongo.

## Consequences
- The thesis claim "RBAC and end-to-end traceability" holds again for the web
  surface: login attempts and every guard decision land in `audit`.
- 14 new `node:test` cases (sessions unit + HTTP integration on an ephemeral port);
  `verify` 118/118. E2E vs live Atlas: anon 401 → login → write 200 → delete →
  logout → token revoked; CORS honored only for listed origins.
- Role `user` still has no write cell (least privilege); reads remain open.
- `AITL_WEB_TOKENS` stays as a documented legacy mechanism, removable later.
- Debt: `aitl init-db` must run once per deployment to materialize the `sessions`
  TTL/unique indexes (done on the current cluster).
