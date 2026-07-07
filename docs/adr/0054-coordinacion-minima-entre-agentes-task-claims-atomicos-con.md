# ADR-0054 — Coordinación mínima entre agentes: task claims atómicos con caducidad, eventos de coordinación y notificación por polling (rebanada v1 del ADR-0002 de la tesis)

- **Status:** accepted
- **Date:** 2026-07-07

## Context

Dos personas (o dos agentes) sobre el mismo proyecto no tenían forma de saber que tocaban la misma tarea ni de enterarse de ADRs nuevos sin consultar manualmente la DB. El ADR-0002 de la tesis (extensión v2, "Propuesto") diseñó task_claims con latido/caducidad, coord_events, change streams y webhooks HMAC; para el piloto basta la rebanada de polling — el transporte es intercambiable después. Restricción: sin transacciones multi-documento; el lock debe ser un mecanismo del índice.

## Decision

(1) Colecciones task_claims (project, task_key, scope, owner_id, claimed_at, heartbeat_at, expires_at REQUERIDO — los claims siempre caducan, TTL default 30 min AITL_CLAIM_TTL_MS, released, released_at) y coord_events (type: claim|release|expire_reclaim|decision|task_done|note, payload). El LOCK es un índice ÚNICO PARCIAL {project, task_key} WHERE released:false: un solo claim activo por tarea, historial de released ilimitado; la carrera del insert la resuelve E11000. Algoritmo sin transacciones: renew-own (re-claim del mismo owner extiende sin evento) → check conflicto ({ok:false, heldBy, expiresAt}) → releaseExpired atómico (solo un racer gana; emite expire_reclaim) → insert. (2) src/coord/: claims/events/storage (bootstrap lazy: el índice parcial debe existir antes del primer write)/cursor. pollEvents asc + cursor máximo; cursor persistido en ~/.aitl/coord-cursor-<sha256(project)[:16]>.json (solo avanza con eventos; primer poll = últimos 60 min). Owner en CLI: AITL_COORD_OWNER → AITL_MCP_ACTOR_ID → cli:<os-user>@<host>. (3) Superficies: tools MCP claim_task/release_task (gated con recurso RBAC nuevo `coordination`: root allow, admin delegated, agent allow) y poll_events read-only; CLI aitl coord {claim,release,list,poll} con poll --quiet apto para hooks (imprime solo si hay eventos, exit 0 siempre). (4) record_decision emite best-effort {type:"decision"} vía recordCoordNote (catch explícito, never block) — registrar un ADR notifica a quien haga poll sobre la misma DB. (5) aitl init (host claude-code) instala también el hook Stop `aitl coord poll --quiet`: la notificación llega al final de cada sesión sin configuración extra.

## Consequences

- El trabajo concurrente se detecta (claim→conflicto con heldBy y expiración visible) y los ADRs nuevos se difunden a los colaboradores por la misma DB — el caso de uso pedido — sin servidor de coordinación ni sondeo de colecciones a mano.
- verify 226/226 (20 tests nuevos con fakes). E2E vivo con dos owners: contención, poll incremental con cursor persistido, release+decision visibles, TTL corto → expire_reclaim; también por MCP (claim_task conflicto correcto). Limpieza completa.
- ADR-0002 de la tesis pasa de "Propuesto" a implementado parcial (claims+eventos+polling); change streams y webhooks HMAC siguen diferidos — solo cambiaría el transporte de coord_events.
- Deuda: heartbeat sin comando propio (renovar = re-claim); force-release root solo por librería; cursor por-máquina (no por owner-id); tests unitarios pueden alcanzar Mongo real si olvidan inyectar el store (candidato a guard global AITL_TEST_NO_NET).
