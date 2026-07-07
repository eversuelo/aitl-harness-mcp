---
name: rbac-registro-implementacion
description: >-
  Estado del RBAC aplicado al harness (ADR-0024): roles, auditoria, guards
  web/MCP, tests.
type: project
category: reference
tags:
  - rbac
  - auth
  - security
  - adr-0024
version: 1
updated_at: 2026-06-28T07:43:46.815Z
---
## RBAC implementado (ciclo actual)

Se aplico el RBAC de docs/RBAC-REGISTRO.md sobre el harness. Ver ADR-0024.

- Fuente unica de politica: src/auth/rbac.ts (MATRIX + can()).
- Roles: root, admin, user, agent, auditor.
- Auditoria: src/auth/audit.ts + coleccion 'audit'.
- Usuarios: bootstrap root-first; aitl user list/create/set-role/disable.
- check-db: src/auth/checkdb.ts ('RBAC status: ready|missing-root').
- Guards: server/api.ts (web) y mcpserver/server.ts (guardTool en runLogged).
- Tests: auth/rbac.test.ts, auth/users.test.ts (npm test via tsx).

Pendiente: login/sesion con contrasena; propagar owner_user al crear prompts.
