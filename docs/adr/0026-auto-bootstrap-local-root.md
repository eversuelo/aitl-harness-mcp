# ADR-0026 — Auto-bootstrap de root local como fallback sin usuario

## Status

accepted

## Context

El servidor MCP arranca pero `bootstrapBaseUser` (`src/auth/users.ts`) lanzaba una
excepción cuando el seed de bootstrap era inválido (p.ej. `AITL_BOOTSTRAP_PASSWORD`
con menos de 12 caracteres), error que `connectDb` (`src/mcpserver/server.ts`)
atrapaba y enterraba en el log (`user:bootstrap:error`). Resultado: nunca se creaba
un root y la colección `users` quedaba vacía.

Aunque los writes por MCP no se bloquean (el server actúa como rol `agent`, que tiene
`allow` en la matriz RBAC, `src/auth/rbac.ts`), no había un root utilizable ni
procedencia humana, y el arranque mostraba un error confuso. El uso real es
single-user local, donde exigir configurar manualmente un password ≥12 antes de poder
usar el harness es fricción innecesaria.

## Decision

`bootstrapBaseUser` ahora **nunca lanza**. Si `users` está vacía y no hay un seed
válido de settings (o su rol no es `root`), genera un root local con
`generateLocalRootSeed()` (username `local-root`, email `local-root@aitl.local`,
password aleatorio `randomBytes(18).toString("base64url")` de ≥12 chars, role `root`)
y devuelve `{ status:"created", generated:true, password }` con el plaintext **una
sola vez** (solo se persiste el hash vía pbkdf2).

- Se añadió `seedIsValid()`, variante no-throw de `validateUserSeed` (que sigue
  estricta para `aitl user create`).
- Nuevo flag de config `bootstrapAutogen` (env `AITL_BOOTSTRAP_AUTOGEN`, default
  `true`; parseo booleano que respeta `false/0/no/off`) desactiva la generación en
  despliegues multi-tenant, donde el bootstrap degrada a `skipped` con razón
  accionable.
- Los callers (`connectDb` en el MCP server y `aitl check-db` vía
  `src/auth/checkdb.ts`) muestran la credencial generada una vez.

## Consequences

- El harness es usable out-of-the-box en local: el arranque deja un root sin
  configuración manual.
- El arranque ya no muestra `user:bootstrap:error` por un password corto; en su lugar
  `user:bootstrap:generated` (una vez) o un `skipped` claro.
- La credencial generada solo se muestra una vez; si se pierde hay que recrear el root
  (no es recuperable, solo se guarda el hash).
- En multi-tenant/cloud se debe poner `AITL_BOOTSTRAP_AUTOGEN=false` y sembrar el root
  explícitamente.
- **Diseño (DSR):** un artefacto que aplica RBAC fail-closed debe degradar de forma
  segura y observable cuando falta su precondición (un usuario), no romper ni quedar
  mudo; el fallback es configurable para no sacrificar la postura de seguridad en
  despliegues compartidos.
- Tests en `src/auth/users.test.ts` cubren autogen sin seed, fallback ante seed
  inválido (no-throw) y no-op cuando ya hay usuarios.
