---
name: thesis-drift-analysis-2026-07-05
description: >-
  Análisis de deriva tesis↔implementación (2026-07-05): bitácora 8 IMPLs atrás
  (0038–0045), invariante "gateway único" roto por ADR-0044, tab:cap3-mcp
  incompleta, H-refs con numeración vieja, estado del arte sin
  LangGraph/AutoGen/CrewAI. Documento completo en
  thesis-harnesss/docs/harness-informe-y-analisis-2026-07-05.md
type: project
category: bug
tags:
  - tesis
  - drift
  - adr
  - estado-del-arte
  - bitacora
  - 'component:thesis-harnesss'
version: 1
updated_at: 2026-07-06T04:57:16.934Z
branch: master
---
Mapeo completo tesis (thesis-harnesss/) vs. harness (AITL-Harness-JS, ledger 0001–0045) hecho el 2026-07-05. Documento de trabajo: **thesis-harnesss/docs/harness-informe-y-analisis-2026-07-05.md** (definición de harness, resumen ejecutivo, bug reparado ADR-0045, auditoría, evolución por fases, comparativa vs. otros harnesses, tabla H1–H11 vs. instrumentación, y plan de modificación por archivo).

Derivas encontradas (por prioridad):
A. **adr/bitacora-decisiones-implementacion.tex** documenta solo IMPL-0001–0037; faltan 0038–0045 (providers locales, hooks tool, --ask, cliente MCP, SDD, corrida viva, Anthropic directo + chat REPL, hardening CLI).
B. **chapter-03** (diseño): invariante #2 "gateway único OpenAI-compat" (líneas 346–359, 675–676) es falso desde ADR-0044 (SDK Anthropic nativo) y 0038 (locales); tab:cap3-mcp lista ~15 de ~60 tools (faltan roles=runtime de H11, software/repo/branch, versionado, graphify, record_human_intervention); record_human_intervention descrito como futuro pero ya existe (aitl intervene + supervision_minutes); capture-session/grafo por sesión (ADR-0034/0035) sin sección; LangGraph nunca nombrado.
C. **chapter-02** estado del arte: compara AWS AgentCore/Hermes/Headroom/SWE-bench pero cero menciones a LangGraph/AutoGen/CrewAI/OpenAI Agents SDK/Aider.
D. **Refs de hipótesis con numeración vieja**: chapter-03:373 (H4→H5), :375 (H5→H4), :376 (H2→H3), :378 (H3→H9), :418 y chapter-05:29 (H7→H10); revisar chapter-05:25,27.
E. **Metadocs rancios**: THESIS-STATE.md (2026-06-21, layout chapter-04..09 inexistente, "H3=agnosticismo"), ADR-0001-harness-agentico.tex:33 ("Capítulos 4/6/8" → 2/3/4, "H1..H6"), To Do.md ("ADR 0001-0018").
F. **Afirmaciones vs. auditoría**: la UI web no puede escribir memoria (RBAC web:anonymous) — acotar la afirmación de trazabilidad E2E o arreglar antes del piloto; aitl eval es stub, el experimento real corre con run --bare (C0/C2).

H1–H11: todas instrumentadas salvo H8 (conversión de fallos→guías es manual) y H9 (portabilidad Claude↔Gemini pendiente de probar). Relacionado: [[tui-stdin-steal-chat-fixes]].
