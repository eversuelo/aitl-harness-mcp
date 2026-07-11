# Architecture Decision Records (ADR log)

Chronological record of the harness's architecture decisions, in the Nygard format
(Context / Decision / Consequences).

**Source of truth:** the `decisions` collection in MongoDB (project `aitl-js`) — query it
with `aitl adr history`, the `list_decisions` MCP tool, or the web UI. The ledger is
contiguous **0001–0070** as of 2026-07-11 — always read the live next-free id from the
collection (skill `adr-ledger-reconcile`), never from docs.

**This directory is a complete mirror** of that ledger, maintained by
`aitl sync --project aitl-js` (bidirectional markdown sync, ADR-0051): every ADR in the
ledger has a `NNNN-slug.md` file here, and edits on either side propagate on the next
sync (conflicts abort without merging; deletions never propagate). Do not hand-maintain
an index table here — filenames carry the id and title, and the ledger state (including
the next free id) is tracked in the repo's `CLAUDE.md`.

Two malformed legacy ledger docs (`0036-mongoose-data-layer`, `0037-branch-aware-repomap`,
non-numeric ids) are skipped by the mirror; their canonical `0036`/`0037` entries are
mirrored normally.

> Historical note: before ADR-0051 the export was selective and one-way
> (`aitl adr-sync`, file → ledger), so older revisions of this README listed
> "ledger-only" ADRs. That distinction no longer exists.
