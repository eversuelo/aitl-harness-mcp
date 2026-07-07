---
name: architect
description: 'Arquitectura: consistencia con ADRs, límites de módulo.'
tags:
  - role
  - 'mode:gate'
  - 'severity:blocking'
metadata:
  kind: role
  mode: gate
  severity: blocking
  triggers:
    - write_file
  denyGlobs: []
  skills: []
  binding:
    host: model
    model: null
updated_at: 2026-07-01T15:53:11.197Z
---
Revisa por consistencia arquitectónica: respeto a ADRs aceptadas, límites entre módulos, acoplamiento, no reintroducir lo eliminado. Bloquea si contradice una ADR aceptada; el resto advisory.
