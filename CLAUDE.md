# CLAUDE.md — AITL-Harness-JS

## Project identity (read first)

This repo is backed by the **aitl-js MCP memory backend**. To keep durable state
(decisions, memory, prompts, skills, agents, context) in ONE place, always use the
canonical project key below — never invent variants from the directory or package name.

| Field | Value |
|-------|-------|
| **Canonical MCP project key** | `aitl-js` |
| **Project hash** | `79cdb3578a8f619c` (`sha256("aitl-js")[:16]`) |

**Rule for every agent / tool call against the `aitl-js` MCP server:** pass
`project: "aitl-js"`. Do **not** use `AITL-Harness`, `AITL-Harness-JS`, or any other
spelling — those fragment the history. Verify the hash above matches
`sha256(project_key)[:16]` before writing if in doubt.

> History note (2026-06-24): durable state had been split across `aitl-js` (the real
> history: ADRs 0001–0009, prompt log, Codex context) and a stray `AITL-Harness-JS` key
> created by mistake. They were merged into `aitl-js`: the stray ADRs were renumbered
> 0010–0013 and the stray key was emptied. ADRs were contiguous 0001–0013 right after
> the merge; subsequent work extended the ledger, which is now contiguous **0001–0033**
> (verified against the `decisions` collection on 2026-06-29; ledger now contiguous
> **0001–0035**; next free **0036**).
> 0032: instrumentación del piloto — slice Schoolar T1/T3, condiciones C0/C2 (`--bare`),
> `aitl run-show`, y quality gate en el loop (`aitl run --verify-cmd`).
> 0033: roles de ingeniería componibles (H11) review/pair/gate que asisten al ingeniero
> (DecisionBrief, objeciones atribuidas) + métrica de supervisión humana (`aitl intervene`).
> 0034: tokens en `run-host` (Cara B) vía `claude -p --output-format json` — levanta el
> bloqueador del piloto (métrica #7 sin OPENROUTER_API_KEY) — + Pilar 4 SDD (auto-clasificación
> de specs `src/specs/`, prompt persistido + síntesis spec↔tarea) + pestaña UI "Runs".
> (0034 tb: `capture-session` registra runs humanos con tokens reales del transcript.)
> 0035: grafo por sesión — `capture-session` extrae artifacts (ADRs/memorias/prompts) del
> transcript y los liga al run; `src/graph/session.ts` + `GET /api/runs/:id/graph` + SessionGraphView.
> Ciclo 0026–0031 (2026-06-28): 0026 auto-bootstrap de root local; 0027 versionamiento
> append-only de ADRs/memoria (`*_history`); 0028 jerarquía software→projects→repos +
> sub-scope `repo`; 0029 knowledge map multi-entidad (graphify + UI); 0030 skill
> constructora + indexador maestro + hook de seed; 0031 clasificación de ramas + grafo
> de branches estilo GitHub.

## Stack

Model-agnostic agent harness. TypeScript (ESM, Node ≥ 20) · LangGraph orchestration ·
MongoDB + Atlas Vector Search as the single durable store · local embeddings
(`Xenova/all-MiniLM-L6-v2`, 384 dims) by default. Connects to Atlas by seedlist with a
local fallback (`MONGODB_URI` → `MONGODB_URI_FALLBACK`); db `aitl`.

## Conventions

- Run `npm run typecheck` and `npm run build` before claiming a change is done.
- Context lookups (memory, decisions, conventions, skills) use a robust cascade
  (vector → text → recency) so they work even before the Atlas vector index exists.
- Architectural changes get an ADR via the `record_decision` MCP tool (next free id;
  currently 0036). Keep ADR ids contiguous and never reuse one. The number is the
  next-free read from the `decisions` collection at BUILD time — never pin it in docs.
