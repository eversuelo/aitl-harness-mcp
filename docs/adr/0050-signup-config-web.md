# ADR-0050 — Registro self-service de usuarios + configuración del harness desde la web UI con espejo al .env

- **Status:** Accepted
- **Date:** 2026-07-06

## Context
Tras ADR-0046 el login web funcionaba pero el alta de usuarios era solo-root por CLI
(`aitl user create`) y la configuración del harness exigía editar `.env` o
`~/.aitl/config.json` a mano. Pedido del usuario: registro por correo+username únicos
desde la web UI y el CLI, y una forma fácil de configurar el harness desde la web UI
cuyos cambios se reflejen en el `.env` en automático. Los índices únicos de `users`
(username, email) ya existían en `db/indexes.ts`.

## Decision
1. **`registerUser`**: validación como `user create`, unicidad por campo con
   `RegistrationConflictError` distinguible (mapea también la carrera E11000), regla
   de arranque: el PRIMER usuario real (excluyendo el bootstrap `local-root`) recibe
   rol `admin`, los siguientes `user`; auditado.
2. **Superficies**: `POST /api/auth/register` gated por `AITL_WEB_ALLOW_SIGNUP`
   (default on; apagado → 403 `signup_disabled`; conflictos → 409; éxito → sesión
   iniciada, mismo shape que login) y CLI `aitl user register` self-service. El
   toggle «Crear cuenta» del LoginDialog se oculta cuando `/api/auth/me` reporta
   `signup:false`.
3. **Config**: `GET /api/config/status` (perfil enmascarado + providerStatus +
   signup_enabled) y `PUT /api/config {updates}` con guard `config_secrets.update` —
   la matriz RBAC gana `admin:"delegated"` en `config_secrets` read/update.
   `applyConfigUpdates` escribe `~/.aitl/config.json` Y espeja las claves al `.env`
   del proyecto vía `updateEnvFile` (`src/config/envfile.ts`: reemplaza líneas
   activas, descomenta `# KEY=` si no hay activa, añade ausentes, `null` comenta la
   línea descartando el valor viejo, preserva todo lo demás). Solo claves de
   `ENV_KEYS` (+`AITL_WEB_ORIGINS`); desconocida → 400; el audit registra solo las
   claves, nunca valores.
4. **Web UI**: pestaña Config (root/admin) con estado de backends/activo/fallback y
   formulario «solo enviar lo que cambió» con secretos tipo password.
5. **CLI**: `aitl config set --env` espeja también al `.env`.

## Consequences
- Onboarding completo sin CLI: instalar → abrir UI → crear cuenta (admin si es el
  primero) → configurar backend → escribir memoria; el CLI ve los mismos valores.
- verify 157/157 (24 tests nuevos), vite build ok. E2E vivo: register + 409s +
  signup off → 403; user → 403 en config; admin PUT → `.env` y perfil espejados,
  `null` desetea, clave desconocida 400; `.env` restaurado md5-idéntico.
- Deuda: la UI no expone el unset por campo (la API sí); los cambios de config no
  recargan settings en caliente (aplican al reiniciar); `AITL_WEB_ALLOW_SIGNUP` se
  lee solo de `process.env`.
- Seguridad: signup default-on para uso local; en despliegues compartidos apagarlo
  con `AITL_WEB_ALLOW_SIGNUP=false`.
