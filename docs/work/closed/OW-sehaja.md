---
labels: [defect]
closed: done
---

# A fork's summary carries the parent's stored preview, and since OW-kekoji both rows are on screen to be compared

Filed 2026-09-13 from the adversarial read of OW-kekoji.
The staleness is pre-existing; OW-kekoji is what made it observable, because the parent is no longer hidden from `list()`.

## The mechanism

`SessionManager.fork` makes no new container: `#adoptRef` re-keys the parent's own `ManagedSession` onto the fork's id.
`session.stored` -- the summary the index handed back for the parent -- rides along untouched.
`summaryOf` in `src/server/http/session-manager.ts` returns `{ ...stored, ref: session.ref, ...this.#liveOverlay(session.ref) }`, so the fork's summary is the parent's `preview` and `updatedAt` wearing the fork's ref.
(Amended 2026-09-13 during execution: this line also said "and title", which nothing can leak -- `SessionSummary` in `src/shared/protocol.ts` carries no title field.)

That summary is what the attach route hands back, so the browser draws the fork's row from it until the next `sessions-changed` refetch replaces it from the index.

## Why it matters now

Before OW-kekoji the parent was filtered out of `list()`, so the stale copy had nothing to be compared against.
Now both rows are listed, and for the beat before the refetch they are character-for-character identical -- which is the symptom OW-vezipo already describes for Codex, arriving on Pi and Claude Code by a different route.
Read OW-vezipo before working this one: the two may want one fix.

## Done when

A test in `src/server/http/session-manager.test.ts` forks a ref-changing session and asserts the fork's `summaryOf` does not carry the parent's `preview`.
It goes red first.

Whether the fix is clearing `stored` on the fork path in `#adoptRef` (so `#ownSummary` answers until the index catches up) or re-reading the index is the card's judgment to make; the first is cheaper and the second is more nearly true.

## Close note

Fixed on `main` in 732769a (cherry-picked from the implementer's `card/OW-sehaja`).

`#adoptRef` now clears `session.stored` when the cause is `"fork"`, so `summaryOf` falls through to `#ownSummary` until the next `list()` picks the fork up from the index.
The rename path is untouched and keeps `stored`, which is right: a rename is the same conversation under a new name.

Re-reading the index was the other option the card named and was rejected for two reasons worth keeping: `#adoptRef` is synchronous and sits in a `finally`, and on Claude Code the fork has no store file at all until its first turn ends (OW-japuzo), so the truer read would usually come back empty and fall through to `#ownSummary` anyway.

Two things the adversarial read caught that the card itself got wrong or did not see:

- The card said the fork inherited the parent's "title".
  Nothing can: `SessionSummary` in `src/shared/protocol.ts` carries no title field.
  The card's mechanism section was amended in this same change to say so.
- Clearing `stored` alone would have opened a second, smaller leak in the same beat.
  `#ownSummary` reports `session.createdAt` as both stamps, and `#start` seeded that field from the parent's *stored* `createdAt`, so a fresh fork would have sorted by a date older than the `updatedAt` it used to carry -- `recency()` in `src/client/time.ts` reads `updatedAt ?? createdAt`, and the row renders `updatedAt`.
  The fork path therefore also sets `session.createdAt = this.#now()`.

The test is "does not hand the fork the parent's stored preview" in `src/server/http/session-manager.test.ts`, in the `fork (the third #adoptRef point)` block, on the Pi-shaped fork -- the only shape whose `adapter.ref` moves and so the only one that reaches this code.
Both halves were shown red first, by the dispatching session and not only by the implementer: the preview half fails `expected 'hello' to be null`, and the stamp half fails `expected '2026-08-10T00:00:00.000Z' to be '2026-08-11T09:30:00.000Z'`.
`bun run check` green, 1060 tests.

Two notes for whoever comes next.

`session.stored` has exactly one reader, `summaryOf`, and exactly one caller outside tests, the `GET /sessions/:ref` attach route in `src/server/http/app.ts`; that is why clearing it is as contained as it is.

That `stored` survives a *rename* is guarded by a single assertion -- `expect(summaryOf(REF)?.preview).toBe("hello")` inside the test named "adopts the id the adapter took during start()".
Mutating the new fork guard to fire on both causes reddens that test and nothing else, so the guard is real but nothing names it.

This does not settle OW-vezipo.
That card is about the fork's *true* preview being the parent's first user message, which is still the case once the index catches up; this one only stopped the fork from wearing a copy it had not earned.
