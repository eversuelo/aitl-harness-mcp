---
name: raytracer-lab-pointer
description: >-
  Existe el laboratorio experimental aitl-raytracer
  (metricas/raytracer/aitl-raytracer): raytracer SDD en 5 fases bajo C0/C2 para
  verificar las hipótesis de la tesis en runtime. Proyecto MCP propio:
  aitl-raytracer (ledger de ADRs independiente).
type: reference
category: uncategorized
tags:
  - experimento
  - raytracer
  - tesis
  - c0-c2
version: 1
updated_at: 2026-07-06T05:52:56.137Z
branch: feat/harness-v2
---
El 2026-07-05 se creó el laboratorio experimental del harness: **metricas/raytracer/aitl-raytracer** (software `raytracer`, project MCP `aitl-raytracer`, hash 8d9c37d22aac48e8). Raytracer TypeScript por SDD en 5 fases (básico → Lambert/Phong → Whitted → BVH/AA → path tracing), cada fase con ramas gemelas fase-N/c0-bare y fase-N/c2-harness para comparar modelo-solo vs harness completo con prompts idénticos. MANUAL.md mapea H1–H11 → verificación en runtime. Los agentes que trabajen ahí deben usar `project: "aitl-raytracer"` — NUNCA aitl-js — y su ledger de ADRs empieza en 0001 (sin colisión con el 0046+ de aitl-js). Complementa el caso Schoolar (metricas/schoolmx, repos reales cms-iecp/managment/backend-saas).
