---
labels: [defect]
---

# The browser keeps a selected session's live view and its preview apart at each path that touches one, and two orderings leave a selection with both or with neither

Filed 2026-09-28 from the adversarial read of OW-lunihe, which a dispatched reader confirmed by running both orderings below against the controller.
Read D25 in `docs/DESIGN.md` first, point 5 in particular.

## The invariant

`ControllerView.preview` in `src/client/controller.ts` is never non-null over a session this tab holds a live view of, and a selected session with neither a view nor a preview is only ever a gesture's fetch in flight.
No single place owns that.
Each path that moves the selection, the preview or a view keeps it for itself: `applyAttached`'s `takesSelection ? { preview: null }` (OW-tatebi), `preview()`'s re-check through `reselectLive` after its fetch resolves (OW-fiheli), and `still()` in `detachGapped` with its `viewOf` clause (OW-lunihe).
A snapshot that introduces a view in `onEvent` consults none of them.

## Ordering one: a selection with neither, stranded

`attachAndSelect` sends `api.attach`, and the server broadcasts the attach's snapshot, which D2 leaves unordered against the REST reply.
If the snapshot lands first and puts the view in place, an event under that handle that gaps drops the view again (`detachGapped`, D25 point 5), and then the reply reaches `applyAttached`, which selects the session with `preview: null` and no view.
The composer sits over an empty transcript, `submit()` succeeds because the server holds the session, and every later event under the handle is ignored until some other snapshot arrives.
The same holds through `create` and through `forkAndSubmit`'s attach of the fork.
Before OW-lunihe, `recover`'s attach sent another snapshot and healed it; nothing does now.

## Ordering two: a selection with both

A preview is on screen for session A, and a snapshot then introduces a live view of A: another client's attach, a transcript replaced or a compaction, a rename, or the reconnect's opening snapshots after `onDisconnect` kept the preview.
`preview` stays non-null while `viewOf(state, selected)` is defined, so `App.svelte` draws the read-only preview and its Attach button, the live view's error, notice and request banners render above it, and the preview poll keeps running.
This was reachable before OW-lunihe through another client's attach.
After it, it is the ordinary outcome of a gap on the selected session followed by any snapshot of that session.

## The change

Give the pairing one owner rather than a fourth check: most likely `onEvent`, or the state transition itself, dropping the preview wherever a view of the selected session appears, and the attach-reply path no longer assuming a snapshot is still to come.
The design is the executor's; the load-bearing part is that the pairing is decided in one place.

## Done when

Two tests in `src/client/controller.test.ts`, each red first on the code as it stands, drive the orderings above and assert the invariant: for the first, the selection ends on a live view or a preview and not on neither; for the second, `preview` is null once the snapshot has landed.
The per-path checks named under "The invariant" that the owner makes redundant are gone, and the commit message names each one it kept and what that one still guards that the owner does not.
`bun run check` passes, and `bun run test:browser` passes if `App.svelte` changes.
