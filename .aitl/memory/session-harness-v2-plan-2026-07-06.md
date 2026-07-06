---
name: session-harness-v2-plan-2026-07-06
description: >-
  Sesión harness-v2 REANUDADA y avanzando (corte tras P4): cerrados P0-P4 + P3.5
  (ADRs 0046-0051), tesis T2 5/6 + T5 + bitácora a IMPL-0051; P5
  (init+degradación) EN VUELO; cola P6-P11. Reanudación futura: To Do.md §0 ya
  no aplica (P3 cerrado); usar este cuerpo.
type: project
category: task
tags:
  - session-2026-07-06
  - plan
  - feat/harness-v2
  - estado-sesion
  - adr-0049
  - adr-0050
  - adr-0051
  - 'component:thesis-harnesss'
version: 4
updated_at: 2026-07-06T20:33:34.520Z
branch: feat/harness-v2
---
SESIÓN REANUDADA (usuario: "continua con el plan"). Espejo local: /home/eversuelo/Code/thesis-harness/PLAN-HARNESS-V2.md (parcialmente desactualizado; este cuerpo manda). To Do vivo: thesis-harnesss/To Do.md.

== CERRADO DESDE LA PAUSA ==
- P3 (ADR-0049; commits 9ea12b5+9e93ad5+81f5ab9): commit-anchor + ciclo de vida ADR. E2E vivo ok. Fix del E2E: `consequences` required:true→default:"" (Mongoose rechaza "" en String required, gotcha ADR-0043); deprecateDecision coalesce. verify 133/133. NOTA operativa: aitl hydrate fuera de hook espera EOF de stdin → invocar con </dev/null en scripts.
- T2 5/6 (tesis, commit a192e00): chapter-03 alineado — puerto N adaptadores (invariante reescrito), tab:cap3-mcp por 10 familias ~45 tools, record_human_intervention implementada, sec:cap3-captura nueva (hydrate/capture-session/dos grafos), párrafo LangGraph retirado (IMPL-0047). Solo falta v2 (~L497-711) tras P7/P8. + fix global cleveref \crefname{section}{sección} en book.tex (dcdaad9).
- T5 (7400605): docs/THESIS-STATE.md regenerado al estado real.
- P3.5 (ADR-0050; commits c8a1459+8edcc1c): signup self-service (RegistrationConflictError username/email + E11000, AITL_WEB_ALLOW_SIGNUP default on, primer real→admin; aitl user register; LoginDialog modo Create-account oculto si me.signup=false) + config web (GET /api/config/status, PUT /api/config gated config_secrets.update con admin:delegated NUEVO en matriz; applyConfigUpdates → ~/.aitl/config.json + espejo .env vía src/config/envfile.ts updateEnvFile; pestaña Config root/admin; aitl config set --env; AITL_WEB_ORIGINS añadida a ENV_KEYS). verify 157/157. Deuda: UI sin unset por campo; config no recarga en caliente.
- P4 (ADR-0051; commits eddf9fa+…+274bf20 tesis): sync markdown bidireccional. src/sync/{export,state,sync}.ts: renderers deterministas; manifiesto .aitl/.sync-state.json de DOS hashes (diskHash+mongoHash: "cambió" = vs propia línea base → prosa manuscrita convive con render canónico); motor 3 estados (conflicto sin tocar exit 2, --pull/--push fuerzan); bootstrap siembra línea base sin escribir cuando ambos lados existen; borrados nunca se propagan; solo ids ADR numéricos. parseAdrMarkdown extendido (lifecycle + variantes legadas). aitl sync + export --adapter markdown; adr-sync intacto. docs/adr COMPLETO 0001-0050 (23 backfilled, 0 manuscritos tocados); .aitl/ 35 memorias+2 skills+5 agents versionado (solo .sync-state.json ignorado). verify 176/176. HALLAZGO: 2 docs legados id malformado en Mongo ("0036-mongoose-data-layer","0037-branch-aware-repomap") — solo reportados, decidir borrado.
- Bitácora tesis al día: IMPL-0049/0050/0051 (filas + párrafos "Trazabilidad al nivel del commit", "Acceso y configuración sin fricción", "El estado durable como archivos legibles"); prosa "cincuenta y una entradas". Ledger contiguo 0001-0051, next free 0052.

== EN VUELO ==
P5 (agente): F9 degradación (run --model auto → getProviderWithFallback como chat, sin cambiar semántica de nombres explícitos; mensajes accionables sin provider; synthesize extractivo con aviso) + F1 aitl init (src/init/initRepo.ts orquestador idempotente: DB/init extraído a función, software+repo+branch sync, indexRepo con skip inteligente, build+role seed, guías merge-sin-pisar, .mcp.json merge conservador apuntando a la instalación del harness, hooks claude-code en .claude/settings.json UserPromptSubmit→hydrate + Stop→capture-session, .git/hooks/post-merge → branch sync --reindex best-effort, --memory-only, reporte [ok|skip|done] + próximos pasos; aitl init padre con subcomandos agent/claude intactos; ajustar NO_DB_COMMANDS). E2E: repo temporal en scratchpad/init-e2e, idempotencia, degradación, limpieza de project init-e2e-test. Al cerrar: commit + ADR 0052 + espejo (vía aitl sync ya!) + ledger CLAUDE.md + fila IMPL-0052 bitácora.

== COLA ==
P6 module map (repomap/modules.ts por dir 1er nivel, kind view|back|mixed|infra ext+ruta override .aitl/modules.json; aitl repomap --modules; MCP get_module_map; module-brief <dir> con ADRs por components[] de P3) → P7 coordinación (taskClaim/coordEvent models; src/coord/{claims,events}.ts claim atómico findOneAndUpdate+heartbeat+expiración; MCP claim_task/release_task/poll_events; aitl coord poll/claim/release; hook en settings de init) → P8 council (src/council/{ports,adapters,rubric,orchestrator}.ts; Zod PlanProposal/PlanCritique; HostClientAdapter reusa CliHostAdapter/HOST_SPECS + AITL_HOST_CMD_*; ProviderClientAdapter jsonSchema; rondas 2 proponer→criticar-anonimizado→juez≠proponentes; sin-voto tras 1 retry; presupuesto NxR; telemetría events+runs; aitl council <task> --hosts; E2E hosts fake AITL_HOST_CMD_FAKE1/2) → P9 TUI rama Task → P10-harness (consolidar docs/ARQUITECTURA*.md, archivar docs/thesis+sessions) → P11 restante tesis: T2-v2 (ADR-0002→parcial, ADR-0003→implementado), bitácora 0052+, T6 humanizar+latexmk+conteo final.

== PENDIENTES SUELTOS ==
Rotar password Atlas + borrar usuario e2e-admin tras piloto; decidir borrado de los 2 docs id-malformado; pnpm-lock.yaml sucio pre-sesión NO commitear; sesión e2e-admin del E2E de P3.5 expira por TTL.

== CONVENCIONES ==
Por fase: verify verde + E2E + record_decision next-free + espejo docs/adr (ahora vía aitl sync) + commit feat/harness-v2 + fila bitácora + conteo prosa. Tesis: skill humanizadora. project="aitl-js" siempre. Relacionado: [[thesis-drift-analysis-2026-07-05]], [[product-positioning]], [[project-identity]].
