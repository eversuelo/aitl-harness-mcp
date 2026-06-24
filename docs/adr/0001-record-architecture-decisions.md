# ADR-0001 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-06-13

## Context
AITL-Harness is a thesis artifact about replacing fragile, probabilistic markdown state in agent
harnesses with **durable, structured, verifiable** artifacts. Architectural decisions must
themselves be durable so that any agent (or human) resuming the work understands *why* the system
is shaped the way it is — this is exactly Pain Point #1 (decision amnesia) that the harness targets.
This applies equally to the TypeScript port (`AITL-Harness-JS`), which must stay in parity with the
Python implementation.

## Decision
We keep Architecture Decision Records (Michael Nygard format: Context / Decision / Consequences)
under `docs/adr/`, versioned in git. At runtime the harness mirrors ADRs into the MongoDB
`decisions` collection (`src/decisions/adr.ts`, command `aitl adr-sync`) so they are
vector-searchable alongside memory and chats. ADR creation/update is meant to be enforced by a hook
when changes affect architecture. ADR numbering is shared across the Python and TypeScript repos so
ids never collide in a common `decisions` project.

## Consequences
- Decisions survive session resets and context compaction.
- ADRs are both human-readable (git) and machine-retrievable (Mongo `$vectorSearch`).
- Slight overhead: architectural changes should be accompanied by an ADR.
