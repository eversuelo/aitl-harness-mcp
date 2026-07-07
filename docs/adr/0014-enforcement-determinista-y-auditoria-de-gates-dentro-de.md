# ADR-0014 — Enforcement determinista y auditoría de gates dentro de runAgent

- **Status:** accepted
- **Date:** 2026-06-24

## Context

El enforcement (el diferenciador de la tesis) era superficial: los gates ([ADR... tools/base + hooks/gates]) solo se instalaban en cli.ts, así que runAgent como librería corría SIN gates ni tools; las denegaciones no se auditaban (el tipo de evento 'gate' existía en el schema pero nadie lo emitía); installDefaultGates no era idempotente. Es el gap #1 del análisis de madurez del harness.

## Decision

Mover tools+gates+auditoría al núcleo (runAgent, src/orchestration/graph.ts): (1) ToolRegistry.call acepta un callback onDeny(reason) y se añadió hasGates(); (2) installDefaultGates es idempotente por registry (WeakSet); (3) runAgent instala gates de seguridad por defecto (opt-out con gates:false), acepta denyPaths como policy por proyecto, y registra los tools built-in con installDefaultTools:true; (4) en el loop, una llamada denegada emite un evento 'gate' {name,decision,reason} y NO un 'tool_call' (que nunca corrió), realimentando el string [denied by gate] al modelo; (5) RunAgentResult expone gate_denials. cli.ts run ahora usa installDefaultTools:true en vez de cablear a mano.

## Consequences

runAgent es seguro por defecto incluso como librería; las denegaciones son medibles/auditables (verificabilidad = promesa de la tesis cumplida). Verificado end-to-end contra Atlas con provider mock: write_file a *.env denegado→evento gate con razón, read_file permitido→tool_call, denegación realimentada al modelo, fichero no escrito, gates idempotentes, gate_denials=1, 0 residuos; typecheck+build limpios. Pendiente del núcleo: resiliencia del loop (retries+resume) e hidratación completa (repomap/ADRs/conventions), antes de Fase C.
