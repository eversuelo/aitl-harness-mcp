# PARITY — AITL-Harness Python ↔ TypeScript

> **Fuente de verdad:** `docs/parity-contract.json` (idéntico en `AITL-Harness/docs/` y
> `AITL-Harness-JS/docs/`). Este `.md` es el render humano de esa matriz. Si algo discrepa,
> manda el JSON.

## Regla central

Cada capacidad del núcleo existe en **ambos** proyectos con el mismo contrato conceptual,
misma entrada/salida, mismo documento MongoDB, mismo comando CLI equivalente, misma MCP tool
equivalente y mismos tests de contrato. `prompt_insights` es la única excepción: extensión
**python-only**.

## Leyenda de estado

| Estado | Significado |
|---|---|
| `equivalent` | Implementado en ambos, contratos + docs Mongo alineados, tests de contrato pasan. |
| `partial` | Implementado en ambos, pero TS es borrador sin typecheck/tests y/o falta el rename de contratos (Fase 1). |
| `missing` | Ausente en uno o ambos proyectos. |
| `python-only` | Extensión intencionalmente solo-Python; nunca se porta a TS. |

## Matriz de paridad

| Capacidad | Python | TypeScript | CLI | MCP tool | Mongo | Tests | Estado |
|---|---|---|---|---|---|---|---|
| config | `aitl/config.py` | `src/config.ts` | — | — | — | none | partial |
| db.client | `aitl/db/client.py` | `src/db/client.ts` | — | — | factory / COLLECTIONS | smoke | partial |
| db.indexes | `aitl/db/indexes.py` | `src/db/indexes.ts` | `init-db` | — | todas + `vector_index` + texto | smoke | partial |
| contracts/schemas | `aitl/memory/schemas.py` | `src/memory/schemas.ts` | — | — | Run/Message/MemoryDoc/ADR/Symbol/Convention/Category/Event | none | partial |
| memory.store | `aitl/memory/store.py` | `src/memory/store.ts` | `search` | `search_memory`,`write_memory` | memory, messages, events | none | partial |
| memory.classifier | `aitl/memory/classifier.py` | `src/memory/classifier.ts` | — | — | categories | none | partial |
| memory.synthesizer | `aitl/memory/synthesizer.py` | `src/memory/synthesizer.ts` | `synthesize` | — | memory(synthesis), events | none | partial |
| providers.base (ProviderPort) | `aitl/providers/base.py` | `src/providers/base.ts` | — | — | — | none | partial |
| providers.gemini | `aitl/providers/gemini.py` | `src/providers/gemini.ts` | `run --model gemini` | — | — | none | partial |
| providers.openai | `aitl/providers/openai.py` | `src/providers/openai.ts` | `run --model openai` | — | — | none | partial |
| providers.anthropic (legacy) | `aitl/providers/anthropic.py` | `src/providers/anthropic.ts` | `run --model anthropic` | — | — | none | partial |
| **providers.antigravity** | `aitl/providers/antigravity.py` | `src/providers/antigravity.ts` | `run --model antigravity` | — | — | none | **missing** |
| orchestration.graph (loop) | `aitl/orchestration/graph.py` | `src/orchestration/graph.ts` | `run` | — | runs, messages, events | none | partial |
| orchestration.checkpointer | `aitl/orchestration/checkpointer.py` | `src/orchestration/checkpointer.ts` | — | — | checkpoints | none | partial |
| context.manager | `aitl/context/manager.py` | `src/context/manager.ts` | — | — | events(compaction) | none | partial |
| tools (base/fs/shell) | `aitl/tools/*.py` | `src/tools/*.ts` | — | — | — | none | partial |
| hooks.gates | `aitl/hooks/gates.py` | `src/hooks/gates.ts` | — | — | events(gate) | none | partial |
| ingest (embedder/markdown/transcripts) | `aitl/ingest/*.py` | `src/ingest/*.ts` | `ingest` | `ingest_path` | memory, messages | none | partial |
| repomap (parser/ranker/store) | `aitl/repomap/*.py` | `src/repomap/*.ts` | `repomap` | `get_repomap` | symbols | none | partial |
| decisions.adr | `aitl/decisions/adr.py` | `src/decisions/adr.ts` | `adr-sync` | `list_decisions`,`record_decision` | decisions | none | partial |
| conventions.loader | `aitl/conventions/loader.py` | `src/conventions/loader.ts` | — | — | conventions | none | partial |
| adapters (agents_md/cursor/…) | `aitl/adapters/*.py` | `src/adapters/*.ts` | `export` | — | conventions, decisions | none | partial |
| eval.runner | `aitl/eval/runner.py` | `src/eval/runner.ts` | `eval` | — | MetricRecord | none | partial |
| mcpserver | `aitl/mcpserver/server.py` | `src/mcpserver/server.ts` | `mcp` | (las 7) | todas (lectura) | none | partial |
| cli | `aitl/cli.py` | `src/cli.ts` | (todos) | — | — | none | partial |
| prompt_insights ✅ | `aitl/prompt_insights/*.py` | — (python-only) | `prompt-insights …` | — | `prompt_*` (5 colecciones) | none | **python-only (implementado)** |

## Progreso de implementación

- **Fase 1 (contratos)** ✅ — `aitl/contracts.py` + `src/contracts.ts` espejados: ports
  (`ProviderPort/ToolPort/MemoryPort/LoopStrategy`), value types (`ToolCall/GateResult/
  MetricRecord/ProviderCapabilities`) y alias canónicos (`DecisionDoc=ADR`, `SymbolDoc=Symbol`,
  `LoopEvent=Event`).
- **Fase 2 (ProviderPort)** ✅ — `count_tokens()` + `capabilities()` en la base y en cada
  proveedor de ambos proyectos.
- **Fase 3 (Gemini)** ✅ plomería — implementado en ambos; `MODEL_PRIMARY=gemini`;
  `getProvider("gemini")` resuelve detrás del puerto (key vacía → `RuntimeError`). Pendiente:
  tests de contrato con fakes + verificación contra API real.
- **Fase 4 (OpenAI)** ✅ plomería — `capabilities()` añadido; mismo shape de tool calls.
  Anthropic conservado como legacy.
- **Fase 7 (paridad de módulos)** ✅ — completados los 9 módulos TS que faltaban
  (`repomap/store`, `decisions/adr`, `conventions/loader`, `adapters/{base,agentsMd,cursor,
  copilot,antigravity,kiro,trae}`, `eval/runner`, `mcpserver/server`, `cli`, `scripts/initDb`,
  `index`) + helper `util/optional` + fix del separador en `ranker.ts`. `aitl --help` lista
  los 10 comandos. Falta tree-sitter wasm real (degrada) — TODO.
- **Fase 9 (prompt_insights, Python-only)** ✅ — `aitl/prompt_insights/{schemas,parser,store,
  runner,cli}.py`; sub-comando `aitl prompt-insights {analyze,history,apply}`; 5 colecciones
  propias (no tocan la lista `COLLECTIONS` compartida → paridad intacta); no destructivo
  (apply escribe `docs/prompt-insights-applied.md` y marca `applied`, sin mutar CLAUDE.md/
  settings.json — TODO con confirmación). Invocación real de `claude-insights` = TODO a verificar.
- **Antigravity** (Fase 5): decisión = **host/orquestador (IDE)** → se modelará como
  `HostAdapter`; `gemini-antigravity` por composición. Aún no implementado.
- Typecheck TS: `npx tsc --noEmit` → **verde (exit 0)**. CLI TS: `aitl --help` **OK**.
  Imports Python + parser prompt_insights: **OK**.

## Hallazgos de la auditoría (Fase 0)

1. **Python**: núcleo completo (16 módulos + 6 adapters). No tiene proveedor `gemini` ni
   `antigravity`; sí tiene `adapters/antigravity.py` (export, ≠ proveedor). `cli.py` aún
   **no** expone el comando `eval` (se añade en Fase 8). Tests: solo `tests/test_smoke.py`.
2. **TypeScript**: 22 archivos en borrador (config, db, memory, providers base/anthropic/openai,
   orchestration, context, tools, hooks, ingest, repomap parser+ranker). **Faltan**:
   `repomap/store`, `decisions/adr`, `conventions/loader`, `adapters/*`, `eval/runner`,
   `mcpserver/server`, `cli`, `scripts/initDb`, e `index`. Sin typecheck ni tests.
3. **Brechas comunes (missing en ambos)**: `providers.gemini`, `providers.antigravity`.
4. **Deuda detectada**: `src/repomap/ranker.ts` usa espacio como separador de claves de nodo
   (rompe rutas con espacios) → cambiar a separador NUL.
5. **prompt_insights**: no existe aún; se construye en Fase 9 solo en Python.

## Qué debe quedar idéntico (campos persistidos)

Los documentos MongoDB deben tener **los mismos campos** en ambos proyectos para que escriban
y lean la misma base. La Fase 1 fija los contratos (`ProviderPort`, `ToolPort`, `MemoryPort`,
`LoopStrategy`, `Run`, `Message`, `ToolCall`, `LoopEvent`, `MemoryDoc`, `DecisionDoc`,
`SymbolDoc`, `GateResult`, `MetricRecord`) con pydantic (Python) y zod (TS).
