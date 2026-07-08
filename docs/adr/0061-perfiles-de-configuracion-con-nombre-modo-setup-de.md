# ADR-0061 — Perfiles de configuración con nombre, modo setup de primer arranque y reinicio guiado (web UI + CLI)

- **Status:** accepted
- **Date:** 2026-07-08
- **Components:** src/config, src/server, src/auth, src/cli.ts, web/src

## Context

La configuración del harness era manual (aitl config set / .env / AITL_HOME) y un solo perfil global. El usuario necesita separar contextos (trabajo/personal) con BD distinta por contexto — manteniendo el multi-proyecto por campo `project` DENTRO de cada BD (ADR-0028) — y poder hacer toda la configuración desde la web UI, con un primer arranque cuyo paso 1 sea crear el usuario Root. Restricciones: `settings` es singleton congelado al importar (config.ts), la conexión Mongoose es única con dbName fijado al boot (ADR-0048) y no existe reload; además `import "dotenv/config"` volcaba el .env a process.env haciendo imposible que un perfil ganara a un .env repo-local. PUT /api/config exige root/admin, pero en una BD fresca no hay usuarios con quienes autenticarse (huevo-y-gallina).

## Decision

(1) PERFILES OVERLAY: `~/.aitl/profiles/&lt;name&gt;.json` + manifiesto `profiles.json` con `active`; un perfil solo pisa las claves que define (típicamente MONGODB_URI/MONGODB_URI_FALLBACK/MONGODB_DB) y hereda el resto del config.json base. Precedencia: env real &gt; perfil activo (AITL_PROFILE &gt; manifiesto) &gt; .env (dotenv) &gt; config.json &gt; defaults zod. El dotenv se carga en config/store.ts con detección de procedencia (snapshot pre-dotenv.config()) para poder insertar el perfil ENCIMA del .env sin quitarle la prioridad al env real. CLI: `aitl config profile {list,create,set,show,use,rm}`; `config unset` ahora valida y espeja --env. Los writes de perfiles NO espejan al .env (contaminaría los otros contextos). Nombres reservados: config, profiles, active.
(2) REINICIO GUIADO, nunca hot-switch: `POST /api/admin/restart` responde 202 y apaga limpio con exit 75 (RESTART_EXIT_CODE); `aitl ui --watch-restart` respawnea mientras el hijo salga 75 (AITL_UI_SUPERVISED=1 → will_respawn en la respuesta). Banner web «reinicio pendiente»: `captureBootProfile()` al boot + `pendingRestartKeys()` (solo NOMBRES de clave) expuesto en GET /api/config/status junto con `sources` (procedencia por clave), `profiles` y `mongo`.
(3) MODO SETUP loopback-only: mientras la BD activa no tenga usuarios reales (excluye local-root, ADR-0026), `/api/setup/status|root|test-connection|connection` operan sin auth pero SOLO desde loopback (403 setup_local_only). `POST /api/setup/root` crea EL root (createSetupRoot eleva la regla primer-usuario→admin de ADR-0050 a root en setup) y abre sesión; los pasos siguientes del wizard van autenticados. Con Mongo caído: paso 0 de conexión (solo claves MONGODB_*, probe con MongoClient efímero que jamás toca la conexión viva) + excepción loopback para restart. Con usuarios reales: 409 setup_closed para siempre.
(4) BD VIRGEN: startUi corre initDb idempotente cuando faltan colecciones núcleo (users/memory) — 1 roundtrip barato en vez de pagar ensureVectorIndexes en cada boot; degrada a warning sin Mongo (F9). Endpoint explícito POST /api/admin/init-db devuelve el DbInitReport (lo usa el resumen del wizard).
(5) RBAC: recurso nuevo `server_admin` (execute: root allow / admin delegated), mismo modelo de confianza que config_secrets (ADR-0050). Web UI: SetupWizard (conexión→Root→proveedor→resumen), RestartBanner, ConfigView con las 35 ENV_KEYS agrupadas + Card de perfiles; AITL_WEB_ALLOW_SIGNUP entra a ENV_KEYS y signup/CORS se leen vía la resolución por capas.

## Consequences

- Separar trabajo/personal ya no requiere tocar env vars a mano: perfil + activar + reiniciar (botón en la UI con --watch-restart). Cada contexto puede vivir en cluster distinto; dentro de cada BD sigue el scope por `project` (cero cambio en la data).
- La re-capa del dotenv es el cambio de comportamiento más delicado: el perfil activo ahora gana al .env repo-local (antes imposible). El env real sigue ganando a todo, así que CI/supervisores no cambian. `sources` en la UI hace visible qué capa produjo cada clave.
- Cambios de conexión NUNCA aplican en caliente — es la garantía del diseño (ADR-0048), no una limitación; pending_restart lista también claves AITL_WEB_* que en realidad se evalúan por request (aceptado por simplicidad).
- Ventana de confianza del modo setup: otros usuarios locales de la misma máquina durante el primer arranque (mismo modelo que el local-root de ADR-0026 que imprime su password por stdout). Se cierra sola al existir el root.
- Una BD nueva por perfil arranca vacía: usuarios/RBAC son por BD (cada contexto crea su propio root vía wizard) y el índice vectorial se crea en el auto-initDb.
- E2E verificado vivo contra atlas-local: wizard (root+sesión, setup_closed después), init-db (21 colecciones, vector ok), perfil personal → pending_restart:[MONGODB_DB] → restart exit-75 → respawn ~2s → BD virgen del perfil entra en setup con auto-initDb → use --none + reinicio → datos y login del root originales intactos. Suite 319/319.
