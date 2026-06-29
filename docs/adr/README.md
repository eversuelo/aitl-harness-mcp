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
| [0009](0009-atlas-migration-via-driver.md) | Migración de base a Atlas vía el driver de Node (`aitl migrate-atlas`) | Accepted | 2026-06-24 |
| 0010 | Conexión a MongoDB Atlas por seedlist con fallback | Accepted | — |
| 0011 | Colecciones agents/skills nativas del harness | Accepted | — |
| 0012 | Fase A — Ciclo de vida de memoria de sesión en runAgent | Accepted | — |
| 0013 | Fase B — Router de skills en la hidratación de runAgent | Accepted | — |
| 0014 | Enforcement determinista y auditoría de gates dentro de runAgent | Accepted | — |
| 0015 | Resiliencia del loop de runAgent (Núcleo H2) | Accepted | — |
| 0016 | Hidratación completa del system prompt (Núcleo H3) | Accepted | — |
| 0017 | Repo map operativo vía extractor heurístico (fallback de tree-sitter) | Accepted | — |
| 0018 | Fase C — Orquestador flaco con sub-agentes paralelos | Accepted | — |
| 0019 | Provider OpenRouter vía gateway compatible con OpenAI | Accepted | — |
| 0020 | Providers consolidados en OpenRouter + HostAdapters | Accepted | — |
| 0021 | Empaquetado para instalación global (npm i -g) y rename a aitl-mcp | Accepted | — |
| 0022 | Inyección/captura de contexto en hosts externos vía hooks | Accepted | — |
| 0023 | Hook de hidratación en SessionStart y rutas POSIX en hooks | Accepted | — |
| 0024 | RBAC y registro de usuarios: AITL como gateway seguro a MongoDB | Accepted | — |

> **Nota de reconciliación (2026-06-29).** Fuente de verdad: la colección `decisions` en Atlas
> (`list_decisions`), hoy con **0001–0034 contiguas** (next-free **0035**). Los ADRs **0010–0034**
> existen en el ledger pero solo algunos están exportados a `.md` aquí (de ahí filas con fecha `—`
> y sin enlace). Hitos recientes: 0025 graphify desacoplado · 0026 auto-bootstrap · 0027 versionado
> append-only · 0028 jerarquía software→repos · 0029 knowledge map · 0030 skills-meta · 0031 grafo de
> ramas · 0032 instrumentación del piloto · 0033 roles H11 · **0034 tokens en `run-host` + SDD
> (specs auto-clasificados/sintetizados) + pestaña UI Runs**. `aitl adr-sync` opera archivo→ledger;
> la inversa (ledger→archivo) es trabajo aparte. Este índice se corrige *hacia* el ledger, nunca al revés.

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
