---
name: reconciliacion-memoria-archivo-vs-mcp-raytracer-2026-07-11
description: >-
  La desambiguación raytracer vs ray-tracer-learning se hizo en DOS sistemas de
  memoria distintos y sin sincronizarse entre sí: catálogo MCP
  (limpieza-catalogo-raytracer-2026-07-12) y archivos locales de Claude Code
  (mapa-proyectos-raytracer.md). Ninguno espeja al otro.
type: reference
category: uncategorized
tags:
  - raytracer
  - memoria
  - catalogo
  - reconciliacion
version: 1
updated_at: 2026-07-12T04:58:26.682Z
branch: feat/harness-v2
commit_sha: f84b9037494c6e7c0f11c99c498e3169eb62b6ae
---
Paralelamente a [[limpieza-catalogo-raytracer-2026-07-12]] (que el 2026-07-12 ordenó softwares/projects duplicados de raytracer en la base de datos MCP), esta sesión (2026-07-11, más temprano, mismo día calendario del usuario) hizo la MISMA desambiguación pero en el sistema de memoria basado en archivos de Claude Code (`~/.claude/projects/-home-eversuelo-Code-thesis-harness/memory/`), que es un almacén completamente distinto al de la colección `memory` de MCP aitl-js y **no se sincroniza automáticamente** con ella (no hay `aitl sync` que cubra este directorio).

**Qué se hizo ahí** (fuera de este MCP, por eso se documenta aquí como puntero): se creó el archivo de memoria `mapa-proyectos-raytracer.md` (tipo reference) confirmando con `git remote -v` + comparación de hashes de `git log --all` (intersección vacía) que:
- `metricas/raytracer` (`github.com/eversuelo/raytracer`, rama `curso`) = laboratorio de evaluación del harness — coincide con lo que ya documentaba [[raytracer-lab-pointer]] para `aitl-raytracer`.
- `metricas/ray-tracer-learning` (`github.com/eversuelo/ray-tracer-learning`, rama `master`) = el motor PBR "Rayo" en sí (este project MCP).
- Son repos **sin historia git compartida**: se corrigió una afirmación falsa en una memoria de archivo anterior que decía que `ray-tracer-learning` fue "generado por las celdas del laboratorio" (no lo fue).

También se reorganizó el índice `MEMORY.md` de ese almacén, agrupando las entradas bajo etiquetas `[ray-tracer-learning]` / `[raytracer/curso-lab]` en vez de dejarlas mezcladas sin distinción — el síntoma que reportó el usuario fue "el proyecto aparece dos veces como work-tree" en `~/.claude/projects/`, que resultó ser dos repos genuinamente distintos con nombre parecido, no una duplicación.

**Nota para quien lea solo el MCP**: este trabajo vive únicamente en archivos locales de esa máquina; si algún día conviene que sobreviva a un reset de disco o sea visible para otras sesiones/máquinas, habría que espejarlo aquí explícitamente (no se hizo en esta sesión — el alcance pedido era el sistema de archivos de Claude Code, no el MCP).
