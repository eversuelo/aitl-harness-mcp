# ADR-0024 — RBAC y registro de usuarios: AITL como gateway seguro a MongoDB

- **Status:** accepted
- **Date:** 2026-06-28

## Context

AITL debe operar como gateway seguro entre usuarios/agentes y MongoDB: ningun cliente web, agente remoto o usuario no-root debe conocer ni usar MONGODB_URI directamente. Faltaba una politica de autorizacion unica, registro de usuarios root-first, auditoria y ownership de prompts. Spec fuente: docs/RBAC-REGISTRO.md.

## Decision

Se implemento RBAC end-to-end siguiendo docs/RBAC-REGISTRO.md. (1) Matriz de permisos como codigo en src/auth/rbac.ts con 5 roles (root/admin/user/agent/auditor) y can()/assertCan(), fail-closed, con celdas 'own' (propio) y 'delegated' (via AITL Server con identidad agent). (2) Auditoria en src/auth/audit.ts (recordAudit + coleccion 'audit' indexada). (3) users.ts endurecido: validacion de rol, bootstrap root-first (config bootstrapRole=root; el primer usuario debe ser root), helpers createUser/setUserRole/setUserDisabled/listUsers, PUBLIC_USER_PROJECTION sin hashes. (4) check-db con flujo RBAC (src/auth/checkdb.ts) y salidas 'RBAC status: ready|missing-root'. (5) Ownership en prompts (actor_id/owner_user + deleteById/getById). (6) Guards en API web (server/api.ts: resolveActor por bearer token AITL_WEB_TOKENS + guard con auditoria en mutaciones; /api/config solo root; endpoints /api/users y DELETE /api/prompts/:id). (7) Guard en MCP (mcpserver/server.ts: guardTool dentro de runLogged, mapa TOOL_RBAC, identidad de servicio agent via AITL_MCP_ACTOR_ROLE/ID). (8) Tests de permisos (auth/rbac.test.ts, auth/users.test.ts; script test ahora node --import tsx). Coleccion 'audit' agregada a COLLECTIONS e indices.

## Consequences

Politica de autorizacion en un unico lugar (rbac.ts) consultada por web, MCP y CLI; toda accion sensible auditada (aceptada y rechazada); secretos/hashes nunca salen al cliente. npm run verify (typecheck + 17 tests) en verde. Pendiente: flujo de login/sesion con cookie y contrasena (hoy identidad web por bearer token) y propagar owner_user al crear prompts desde web/MCP (esquema y guard de borrado ya lo soportan).
