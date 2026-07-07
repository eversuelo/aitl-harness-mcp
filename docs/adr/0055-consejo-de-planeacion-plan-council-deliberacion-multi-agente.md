# ADR-0055 — Consejo de planeación (plan-council): deliberación multi-agente antes de ejecutar

- **Status:** accepted
- **Date:** 2026-07-07
- **Components:** src/council, src/hosts, src/util, src/cli.ts

## Context

El ADR-0003 de la tesis propone que, antes de ejecutar una tarea no trivial, varios agentes deliberen sobre el plan: proponer en paralelo, criticar de forma anónima y que un juez distinto de los proponentes emita un veredicto. El harness ya tenía las piezas: HostAdapters con HOST_SPECS y overrides AITL_HOST_CMD_* (Cara B), ProviderPort con constrained decoding vía CompleteOpts.jsonSchema (ADR-0044), telemetría runs+events y memoria durable. Faltaba el orquestador de deliberación. Riesgos a controlar: sesgo de autoría (un agente favorece su propia propuesta), salidas no estructuradas de los hosts, presupuesto de invocaciones sin cota, y que el consejo edite archivos cuando solo debe planear.

## Decision

Se implementa src/council/ (rebanada v1): ports.ts define CouncilClientPort y esquemas Zod PlanProposal/PlanCritique/CouncilVerdict; adapters.ts trae HostClientAdapter (invocación del host en SOLO LECTURA vía readonlyArgs por spec — claude-code `--permission-mode plan`, codex `--sandbox read-only` — y extracción de JSON balanceado factorizada a src/util/json.ts) y ProviderClientAdapter (jsonSchema con enum dinámico de etiquetas); rubric.ts pondera correctness .30 / completeness .20 / risk .20 / simplicity .15 / verifiability .15 con agregación pura y determinista; orchestrator.ts corre R1 proponer en paralelo → etiquetas anónimas A/B/C en orden aleatorio estable → R2 criticar solo propuestas AJENAS → juez ≠ proponentes (≥3 clientes: el último solo juzga; 2 sin --judge: error). JSON inválido recibe 1 retry citando el error de validación; el segundo fallo es SIN-VOTO y el consejo continúa con quórum ≥2 propuestas. Presupuesto duro N clientes × R rondas (+1 retry por cliente/ronda); el juicio no cuenta como ronda. Telemetría: run kind council, eventos council_propose/critique/no_vote/verdict con duration_ms y tokens cuando el host los reporta, y el veredicto persiste como memoria type design ligada al run — todo best-effort con degradación sin backend. CLI: aitl council "<task>" --hosts a,b[,c] [--judge host|provider[:modelo]] [--rounds 2] [--json]. E2E con hosts fake por AITL_HOST_CMD_* (fixtures stdin, sin red ni modelo ni Mongo).

## Consequences

- La deliberación pre-ejecución del ADR-0003 de la tesis pasa de diseño a artefacto medible (veredictos como memorias design, telemetría por cliente/ronda).
- La anonimización estructural (nunca ver la propia propuesta; autorías solo al final) mitiga el sesgo de autoría por construcción, no por prompt.
- El modo solo-lectura por spec de host garantiza que planear nunca edita el repo; antigravity no tiene flag readonly conocido (queda solo la prohibición en el prompt).
- El costo queda acotado: máx. N×R invocaciones + 1 retry por cliente/ronda; sin-voto degrada con quórum en vez de abortar.
- Pendiente: probar la ruta de telemetría contra Mongo vivo (los tests usan seams fake por diseño) y la integración en la TUI (P9). verify 249/249.
