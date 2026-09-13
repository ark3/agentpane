---
labels: [defect]
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
