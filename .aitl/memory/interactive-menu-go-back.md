---
name: interactive-menu-go-back
description: 'Panel interactivo: menú en árbol con navegación Go Back'
type: project
category: decision
tags:
  - cli
  - interactive
  - tui
  - ux
  - go-back
version: 1
updated_at: 2026-06-24T14:56:32.790Z
---
Mejora del panel interactivo (aitl -i, src/interactive/menu.ts), 2026-06-24. Enhancement de [ADR-0008], no cambia arquitectura.

El menú plano pasó a ser un árbol navegable con retroceso ("Go Back"):
- Submenús: Services (start/stop MCP, UI), Memory (search, run, run-host, orchestrate), Database (check-db, init-db), Config (show, path); más Type a command (:) y Quit en la raíz.
- Go Back: ítem "← Back" en cada submenú + teclas Esc / Backspace / ← (flecha izq.); no-op en la raíz.
- Breadcrumb en la cabecera (AITL · interactive › Memory) y pista "Esc/← back" solo en submenús.
- Implementación: pila de niveles (stack: MenuLevel[]); enter() hace push a submenu o corre la acción hoja; goBack() hace pop. Sigue cero-dependencias y re-spawnea el mismo CLI.
- De paso se superficiaron run-host y orchestrate en el menú.

Verificado: typecheck+build limpios; el módulo carga (guarda de no-TTY responde). La navegación por teclado real requiere TTY (no simulable en el entorno de prueba).
