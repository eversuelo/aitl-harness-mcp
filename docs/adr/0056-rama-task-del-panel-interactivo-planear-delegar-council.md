# ADR-0056 — Rama «Task» del panel interactivo: Planear / Delegar / Council

- **Status:** accepted
- **Date:** 2026-07-07
- **Components:** src/interactive, src/specs, src/council

## Context

El panel interactivo (ADR-0008, supervisor readline sin dependencias) ya arrancaba servicios y despachaba comandos, pero las capacidades operativas del harness — descomponer una tarea (SDD, ADR-0042), delegarla a un host (run-host) y deliberar el plan en consejo (ADR-0055) — solo existían como subcomandos sueltos del CLI. Para la tesis, el punto de entrada operativo debe hacer observable el ciclo completo sobre UNA tarea escrita por el humano: planear → deliberar → delegar. Además, al operar hay contexto de coordinación pendiente (eventos de ADR-0054) y el servicio MCP local suele ser prerequisito. Restricción dura: los flujos comparten la TTY con el menú raw-mode, con la disciplina de stdin de ADR-0045 (suspend() pausa stdin para no robar teclas al hijo).

## Decision

Añadir una rama «Task» de primer nivel al panel readline (`src/interactive/`):

1. **Al entrar** (best-effort, no bloqueante): si el servicio MCP está apagado se arranca como servicio supervisado, y se lanza `aitl coord poll --project <p> --quiet` (cursor incremental persistente, ADR-0054) cuya salida cae como notificaciones en el panel de logs.
2. **Disponibilidad como funciones puras** (`taskLogic.ts`): `detectAvailableHosts` (sonda PATH por spec + override `AITL_HOST_CMD_<NAME>`, el mismo seam de `getHost`), `planCouncilSeats` (composición de asientos: ≥2 proponentes distintos + juez distinto — hosts proponen y un provider juzga; con ≥3 hosts el último juzga; providers rellenan asientos faltantes) y `computeTaskActions` (acción deshabilitada ⇒ razón legible mostrada tal cual en el menú). La disponibilidad se re-sondea en cada render.
3. **Flujos in-process bajo `suspend()`** (`task.ts`, TaskIO inyectable respaldado por readline; los hosts hijos corren con stdio PIPED — nunca compiten por la TTY):
   - **Planear** → `runSddPipelinePreview` (`src/specs/pipeline.ts`): el pipeline SDD corre contra un `BufferMemoryStore` en memoria (sin Run, sin eventos); los artefactos spec/design/tasks se muestran primero y solo se persisten tras confirmación explícita (`persist()` idempotente).
   - **Delegar** → selector numerado de hosts disponibles; con backend es el wrap completo `runOnHost` (hidratación + run + tokens/costo); sin backend degrada a `getHost().runTask` directo con el aviso estándar.
   - **Council** → `runCouncil` (ADR-0055) con los asientos compuestos, resumen vía `formatCouncilSummary` y handoff: ofrecer delegar el plan ganador (`buildWinnerDelegationPrompt`) a un host elegido.
4. **Degradación (contrato F9)**: sin Mongo los flujos CORREN con un aviso y no persisten (`probeBackend` decide una vez por flujo); sin modelo/hosts las acciones se deshabilitan aguas arriba con su razón.

Atajo de teclado `t` y entrada «Task (t) ▸» primera en el menú raíz.

## Consequences

- La TUI pasa a ser el punto de entrada operativo del harness: el ciclo planear→deliberar→delegar es observable y confirmable por el humano en una sola superficie.
- Los seams puros (specs/isOnPath/TaskIO inyectables) permiten probar disponibilidad y flujos headless sin hosts, modelo ni Mongo: 19 tests nuevos (268 en total), más E2E de Delegar con host fake vía `AITL_HOST_CMD_*`.
- El modo preview del SDD nunca escribe telemetría: persistir es una decisión explícita del humano (confirm-before-write).
- Paridad-neutral: ergonomía TS-only del panel (ADR-0008); no toca `docs/parity-contract.json`.
- La «TUI Ink» de ADR-0003/0004 sigue reservada al chat en vivo; la rama Task vive en el supervisor readline, que es la TUI operativa real del proyecto.
