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
> 0010–0013 and the stray key was emptied. ADRs are now contiguous 0001–0013.

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
  currently 0020). Keep ADR ids contiguous and never reuse one.
