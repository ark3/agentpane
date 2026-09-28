---
labels: [defect]
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

The card's call, between at least these two:

- A listing asked for while one is in flight is owed a fresh one after it, so a broadcast that joins a stale listing still gets an answer given after it was sent; this fixes the coalescing for every `sessions-changed`, not only an attach's.
- `detachable` and the stripe read the pane's mode (`paneMode` in `src/client/controller.ts`) for the selected session rather than the row's `status`; this fixes Detach but not the stripe on rows not selected.

Whichever is taken, the listing stays the only writer of `status`: an attach reply writing it again is what OW-wazija closed.

## Done when

A test in `src/client/controller.test.ts`, red first on `main` as OW-forinu left it: the probed ordering above ends with the session's row reading `attached` (or, under the second option, with an `App.test.ts` test showing Detach enabled over the live view).
`bun run check` passes.
