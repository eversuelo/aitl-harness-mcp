---
name: session-0af49b85
description: Session summary (decision) — run 0af49b85
type: project
category: decision
tags:
  - session
  - decision
  - 'host:claude-code'
  - 'component:home/eversuelo'
  - 'component:src/server'
version: 2
updated_at: 2026-07-13T20:39:20.265Z
branch: feat/harness-v2
commit_sha: ac395a7bf0004a55df98d4838dc856f885cdb1df
---
Voy a leer el config que quieres usar como perfil.

[tool Read]

[tool Bash]

[tool Bash]

[tool Bash]

[tool Bash]

Ahora entiendo: son dos clusters distintos (`web-sites.0sqblvc` en el actual vs `Cluster0/m2pdgbz` en el de Downloads). Déjame verificar cómo se resuelve la config en runtime antes de tocar nada, porque hay una trampa con `.mcp.json`.

[tool Bash]

[tool Bash]

Antes de decidir, necesito confirmar que el runtime consume la capa de perfiles (no `process.env` crudo), porque el bloque `env` de `.mcp.json` es *env real* y le gana a cualquier profile.

[tool Bash]

[tool Read]

Confirmado el mecanismo: `src/config.ts:96` resuelve por capas (**env real > profile activo > `.env` > `~/.aitl/config.json`**). La trampa es que el bloque `env` de `.mcp.json` es *env real*, así que hoy el servidor `aitl-js` está clavado al cluster `web-sites` pase lo que pase con los perfiles. Voy a comprobar dos cosas antes de escribir.

[tool Bash]

[tool Bash]

[tool Bash]

[tool Bash]

Ya tengo lo que necesitaba. Un detalle importante que encontré: `MODEL_PRIMARY: "gemini"` / `MODEL_SECONDARY: "openai"` de ese config **no son providers válidos** en este harness (solo `auto|anthropic|openrouter|lmstudio|openai-compat`, ver `src/providers/base.ts:71`), así que no los voy a copiar — lo que importa para "son dos bases de datos" son las claves de Mongo.

[tool Bash]

Perfecto: el perfil es un JSON plano de claves ENV. Creo el perfil `work` con las claves de Mongo del config de Downloads (dejando fuera `MODEL_PRIMARY/SECONDARY`, que ese archivo trae con valores que este harness no reconoce).

[edit Write: /home/eversuelo/.aitl/profiles/work.json]

Entendido — el servidor de *work* va en `/home/eversuelo/Code/Work/`, no como segundo servidor en este repo. Déjame ver qué hay ahí y cómo se puede lanzar el binario.

[tool Bash]

`aitl` está instalado global (`aitl-mcp@0.1.0` → symlink a este repo), así que en Work puedo invocar el binario directo sin `npm --prefix`. Verifico el subcoman
