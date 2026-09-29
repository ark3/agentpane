---
labels: [change, sweep-0929]
blocked-by: [OW-sodohi]
---

# The browser drops a dead view from a listing, a snapshot of the same ref and detach()'s own reply, three inferences D26 retires for the ended event

Filed 2026-09-29 by OW-zavehi, whose decision is D26 in `docs/DESIGN.md`, point 4.
OW-sodohi makes the server send `ended` where it forgets a handle and makes the shared reducer drop the view on it; this card removes the inferences the browser made before it, so that `ended` is the one owner of "this handle has ended" while the stream is up.

## What goes

- The missing-handle drop in `replaceSessionSummaries` in `src/client/session-state.ts` (OW-pihuko): a view held when the listing was asked whose handle the listing lacks.
- The detached-by-ref drop beside it: a view paired by ref with a `detached` summary.
  Its test in `src/client/session-state.test.ts`, "drops a view held when the listing was asked…", only reaches it after the first drop has already fired.
- `withoutOtherViewsOf` in the reducer's `snapshot` arm, which drops another handle's view of the same ref: once `ended` precedes any re-attach's snapshot (a re-attach waits out the disposal, and `close()` sends `ended` before its first await), nothing reaches it.
  The reducer is shared with the helper in `src/emacs/helper.ts`, whose `attached` map this drop never updated; the helper's tests stay green.
- `detach()` in `src/client/controller.ts` dropping its own view after `api.close` resolves; the view drops whenever `ended` lands, which the server writes before it answers the DELETE, though the stream and the reply are unordered (D2), so the pane may stay live until `ended` arrives.
  Its no-disk exit stays: that is the card that clears the selection on the preview's `gone`, which this card does not touch.

## What stays

OW-fihuma's summary restore in `replaceSessionSummaries`, which answers a stale listing racing an attach, not an end.
The listing's rows and their `status`, which it alone owns (OW-forinu).
D21's reconnect listing and D25's `onDisconnect` dropping everything.

## Records that change with it

`docs/DESIGN.md` D21's "the opening snapshot under it drops the view the old handle held for that ref" and D24's "leaves one view of the ref, under the new handle", both of which describe `withoutOtherViewsOf`.
The docblocks of `replaceSessionSummaries`, the reducer's OW-pezazo comment, `setSessionCompaction` and `compact()` in `src/client/controller.ts` ("a gap, a drop or a listing can take it"), and `detach()`'s passage "Bailing costs nothing: the re-list the close broadcasts drops the dead view on its own".

## Done when

Red first, in `src/client/session-state.test.ts` or `src/client/controller.test.ts`: a listing that lacks a held view's handle, with no `ended`, leaves the view in place; and a snapshot under a new handle for a ref another handle's view holds leaves that view in place.
Kept green as a pin, since OW-sodohi already makes it pass: another client's close of the selected live session, with the stream up and the listing its `sessions-changed` asks failing, leaves the tab holding no view of it.
The three drops and `detach()`'s local drop are gone from the code, and the tests that pinned them drive `ended` instead or are removed with them.
`bun run check` passes.
