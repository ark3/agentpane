---
labels: [change]
blocked-by: [OW-vezipo, OW-bumonu]
---

# The browser draws a fork's row as a copy of its parent's, with nothing marking the lineage forkedFrom carries (D27)

`src/client/App.svelte` (the session row markup and `sessionLabel`), `src/client/App.test.ts`.

The browser half of fork lineage, under `docs/DESIGN.md` D27.
OW-vezipo puts `forkedFrom` on `SessionSummary`; this card draws it.
Its Emacs twin is filed beside it, blocked by the same card, per `AGENTS.md`, "Both clients".

A fork's label follows the same rule as any row and so is usually its parent's; D27 chose a marker over taking the preview from the fork point or nesting a fork under its parent.
The row carries a fork marker whose tooltip names the parent by its own label, or by its id when the parent is not among the summaries the client holds, hidden ones included.
Hiding forks automatically is not this card's: D27 leaves it deferred until use says which forks deserve it.

## Done when

Watched red first, in `src/client/App.test.ts`: a row whose summary carries `forkedFrom` naming a listed parent draws the marker with that parent's label in its tooltip, and a row with `forkedFrom` null draws none.
`bun run check` passes.
