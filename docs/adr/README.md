# Bitácora de decisiones (ADR log)

Registro cronológico de las decisiones de arquitectura del harness. Formato Nygard
(Context / Decision / Consequences). Cada ADR vive como markdown en git **y** se espeja
en la colección `decisions` de Mongo vía `aitl adr-sync --dir docs/adr --project <p>`
(ver [ADR-0001]). La numeración continúa el corpus compartido de la tesis.

| ADR | Título | Estado | Fecha |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | 2026-06-13 |
| [0002](0002-mongodb-atlas-vector-search.md) | MongoDB Atlas Vector Search como único store durable | Accepted | 2026-06-13 |
| [0003](0003-interactive-tui-live-agent-chat.md) | TUI interactivo ("live agent chat") como superficie de primera clase del CLI | Accepted | 2026-06-23 |
| [0004](0004-ink-as-tui-rendering-library.md) | Ink (React para terminal) como librería de render del TUI | Accepted | 2026-06-23 |
| [0005](0005-streaming-in-provider-port.md) | Streaming en el ProviderPort antes de construir el TUI | Accepted | 2026-06-23 |
| [0006](0006-user-level-config-profile.md) | Perfil de config a nivel usuario (`~/.aitl/config.json`) con export/import para `npm i -g` | Accepted | 2026-06-23 |
| [0007](0007-memory-admin-web-ui.md) | UI web de administración de memorias sobre una proyección HTTP de `MemoryStore` | Accepted | 2026-06-23 |
| [0008](0008-interactive-control-panel.md) | Panel de control interactivo (`aitl -i`) como supervisor readline sin dependencias | Accepted | 2026-06-23 |

## Hilo de la sesión 2026-06-23

Las decisiones 0003–0005 salen de una misma conversación: construir un harness
agnóstico empezando por el CLI y un TUI. Tres bifurcaciones resueltas con el usuario:

1. **Foco del TUI** → *live agent chat* (sobre navegador de memoria o dashboard). → ADR-0003
2. **Librería** → *Ink* (sobre readline+ANSI). → ADR-0004
3. **Orden de arranque** → *streaming en el ProviderPort primero* (antes del esqueleto del
   TUI o de refinar el CLI). → ADR-0005

El plan de ejecución derivado de estas tres está en
[`../TUI-IMPLEMENTATION-PLAN.md`](../TUI-IMPLEMENTATION-PLAN.md).

[ADR-0001]: 0001-record-architecture-decisions.md
