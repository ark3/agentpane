---
labels: [defect]
closed: done
---

# Since OW-forinu an attach reply no longer lights its row, so a sessions-changed that joins a listing already in flight leaves a live session's row reading detached and Detach disabled until some later listing

Found by the adversarial read of OW-forinu on 2026-09-28 and proved there with a throwaway probe against the controller; a regression of OW-forinu against `main` at 377ba9d.

## What happens

OW-forinu made the listing the only writer of a row's `status`: `replaceSummary` in `src/client/controller.ts` now keeps the listed row's `status` and gives a row no listing has named `detached` (its docblock says why, citing OW-wazija).
`refreshSessions` in the same file coalesces: a call made while `refreshInFlight` is set returns that listing's promise rather than asking again.
So when a listing is already out as the user attaches, the `sessions-changed` the attach broadcasts joins it, and that listing, answered before the attach, says `detached`.
`replaceSessionSummaries` in `src/client/session-state.ts` keeps the current row over a listing older than the view (OW-fihuma), and the current row now carries that old `detached` too.
Probed ordering: a listing in flight, then `select`, its snapshot lands, the attach's `sessions-changed` joins the listing, the listing resolves with the session `detached`; `api.listSessions` was called only for startup and the in-flight listing.
Result: a live view whose row reads `detached`, so the sidebar's stripe is off and `detachable` in `src/client/App.svelte` keeps Detach disabled, until the next listing, which is usually the first turn boundary (OW-furinu).
Before OW-forinu the reply's own `attached` write covered this ordering.

## The change

Decided by the owner on 2026-09-28: fix the coalescing, which is the root, and not the attach.
Every `sessions-changed` that joins a listing already in flight gets an answer given before the change it announces, not only an attach's: the turn-boundary broadcast (OW-furinu) and another client's close do too; the attach reply's own `status` write hid only the attach's case until OW-forinu retired it.

`refreshSessions` in `src/client/controller.ts` keeps coalescing, and owes one fresh listing: a call that arrives while a listing is in flight marks it, and when that listing lands, exactly one more is asked, whose answer is the one the callers who arrived meanwhile wait for.
At most one listing is in flight and one owed, however many broadcasts arrive, so a burst cannot pile requests up.
A `surface` caller that joins keeps owning the status line and error slot for the listing it waits on, as `refreshSurfacing` gives it today.
The listing stays the only writer of a row's `status`: an attach reply writing it again is what OW-wazija closed.
Deriving `detachable` in `src/client/App.svelte` from `paneMode` instead of the row's `status` was the card's other option; the owner did not take it, since the fix above covers Detach and the stripe together.

## Done when

A test in `src/client/controller.test.ts`, red first on `main` as OW-forinu left it, drives the probed ordering above and asserts the session's row ends `attached`, with `api.listSessions` called once more after the in-flight listing lands.
A second test holds one listing in flight, delivers several `sessions-changed`, and asserts exactly one further listing follows it.
The existing coalescing tests pass, or are changed and named in the commit message.
`bun run check` passes.

## Close note

Landed on main as eebcb7b and 3eb65ff.
`refreshSessions` in `src/client/controller.ts` keeps coalescing and owes one fresh listing: a call that arrives while a listing is out waits on exactly one more, asked when that one lands, so an attach whose `sessions-changed` joins a listing in flight now ends with its row `attached`.
There is at most one listing out and one owed.
A Refresh press that joins owns only what it owned before: the owed listing's failure and its idle, never a start announcement, which would clobber an attach made after the press (found by the adversarial read, fixed in 3eb65ff).
The owed listing refreshes the preview like any listing.
A first open that lands inside the startup listing now lists once more after it; D21 carries an amendment line saying so.
New tests in `src/client/controller.test.ts`, each shown red on the unfixed code: "lights the row of a session attached while a listing was in flight (OW-sabova)", "coalesces a burst of session-list refreshes into one owed listing", "lists once more after the startup listing when the first open lands inside it", and the two "leaves an attach made after a joining Refresh ..." variants.
Changed tests are named in the commit messages.
`bun run check` passes, 1505 tests.
The review also surfaced a pre-existing gap in D21's first-open skip, filed as OW-dajove.
