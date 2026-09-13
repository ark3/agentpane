---
labels: [defect]
closed: done
---

# Edit controls vanish for a whole turn after a Pi fork, because the fork-points refresh is dropped on the rename

Noticed during OW-roveze's execution and deliberately not fixed there.

**What happens.**
`refreshForkPoints` in `src/client/controller.ts` guards its reply on the session still being selected: it captures `const key = sessionKey(ref)` before the request and, in the `.then`, returns without publishing unless `sessionKey(view.state.selected) === key`.
Pi's fork renames the session mid-flight -- `PiAdapter.fork` re-adopts the moved active file and the server reports `renamed`, which is why `forkAndSubmit` already tracks the ref through a rename (see the note at `api.fork` and D9).
So a refresh in flight across that rename is discarded: the key it captured no longer names the selected session.

`forkIndices` is then left holding whatever it held before, or `null`, and nothing re-asks until the next turn boundary -- `onEvent` refreshes on a snapshot or an `isStreaming` transition, and a rename is neither.

**What the user sees.**
Immediately after forking, the transcript's Edit controls are drawn from a stale or absent set, and "Edit last message" takes the same gate.
This is exactly when someone is most likely to want another edit: they just reworded a message and landed in a fork.
It self-heals within one turn, which is why it was not fixed inside OW-roveze.

**A second, smaller one in the same place.**
A `renamed` event triggers one spurious refresh: the `wasStreaming` capture in `onEvent` reads `view.state.sessions[sessionKey(event.session)]` under the *new* key, which holds nothing, so `isStreaming !== wasStreaming` reads as a transition.
Harmless -- a snapshot follows immediately and would have refreshed anyway -- and named here only so the next reader does not file it twice.

**Load-bearing vs incidental.**
Load-bearing: that the guard is keyed on the session key and a rename changes the key, so identity-through-rename is the thing missing, not the guard.
`controller.ts` already has the machinery -- `forkAndSubmit` tracks its ref through a rename in flight, and `onRename` listeners exist.
Incidental: whether the fix is to re-key the in-flight refresh on `renamed`, or simply to refresh on `renamed` as well.

## Done when

A test in `src/client/controller.test.ts` goes red first: a `refreshForkPoints` in flight when a `renamed` event lands for that session, asserting `forkIndices` ends up describing the renamed session rather than staying stale -- and green after.

## Close note

Fixed in 6e71b0c on `main`: `refreshForkPoints` in `src/client/controller.ts` now tracks its target through a rename in flight, reusing the `renameListeners` pattern `submit` and `forkAndSubmit` already use, and moving its `forkPointsInFlight` entry to the new key with it.
`key` became `let`, an `onRename` listener re-keys both it and the in-flight set, and the `finally` removes the listener alongside the set entry.
The docblock above the function needed no change: the fix adds no new refresh trigger, it only keeps the one already in flight alive across the rename.

Verified red first, by the executing session and not only by the implementer: with `src/client/controller.ts` reverted to the parent commit and the new test in place, `bun run test -- src/client/controller.test.ts -t "OW-lizohe"` fails with `AssertionError: expected null to deeply equal [ +0 ]` -- `forkIndices` stayed `null`, exactly the stale-set case this card describes -- and passes with the fix.
The test defers the attach's `forkPoints`, emits `renamed` while it is in flight, resolves it, then asserts both that selection moved and that `forkIndices` is `[0]`.
`bun run check` green: 49 files, 1043 tests.

The second, smaller issue this card names -- the one spurious refresh a `renamed` event triggers through the `wasStreaming` capture in `onEvent` -- was left alone as the card intended; the fix does not subsume it.
One correction to the card on that point, for a later reader: it is narrower than the card says.
It fires only when the session was streaming across the rename, because with `isStreaming` false on both sides the comparison is `false !== false` and no refresh happens at all.
Still harmless, and still not worth its own card.
