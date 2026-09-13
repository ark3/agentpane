---
labels: [defect]
---

# A fork's summary carries the parent's stored preview, and since OW-kekoji both rows are on screen to be compared

Filed 2026-09-13 from the adversarial read of OW-kekoji.
The staleness is pre-existing; OW-kekoji is what made it observable, because the parent is no longer hidden from `list()`.

## The mechanism

`SessionManager.fork` makes no new container: `#adoptRef` re-keys the parent's own `ManagedSession` onto the fork's id.
`session.stored` -- the summary the index handed back for the parent -- rides along untouched.
`summaryOf` in `src/server/http/session-manager.ts` returns `{ ...stored, ref: session.ref, ...this.#liveOverlay(session.ref) }`, so the fork's summary is the parent's `preview`, `updatedAt` and title wearing the fork's ref.

That summary is what the attach route hands back, so the browser draws the fork's row from it until the next `sessions-changed` refetch replaces it from the index.

## Why it matters now

Before OW-kekoji the parent was filtered out of `list()`, so the stale copy had nothing to be compared against.
Now both rows are listed, and for the beat before the refetch they are character-for-character identical -- which is the symptom OW-vezipo already describes for Codex, arriving on Pi and Claude Code by a different route.
Read OW-vezipo before working this one: the two may want one fix.

## Done when

A test in `src/server/http/session-manager.test.ts` forks a ref-changing session and asserts the fork's `summaryOf` does not carry the parent's `preview`.
It goes red first.

Whether the fix is clearing `stored` on the fork path in `#adoptRef` (so `#ownSummary` answers until the index catches up) or re-reading the index is the card's judgment to make; the first is cheaper and the second is more nearly true.
