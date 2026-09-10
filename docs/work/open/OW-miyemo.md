---
labels: [defect]
---

# A fork abandoned by a mid-flight click leaves the forked session orphaned on the backend

Surfaced by the implementer and the adversarial reader on OW-mifuki, 2026-09-10; confirmed by reading `src/client/controller.ts`, not reproduced against a running backend.

OW-mifuki made `forkAndSubmit` honour a selection made during its round trip: it now re-checks `disposed || intent !== selectionIntent` after every await and returns null when the user clicked elsewhere.
The guard immediately after `const forked = await api.fork(ref, { entryId: point.id });` fires with the fork already created.
Nothing attaches it, nothing deletes it, and the user never sees it until it turns up in the sidebar on the next listing.

The shape is pre-existing — a rejected `api.attach` left the same orphan — but before OW-mifuki that needed a failure, and now an ordinary click during the fork's attach reaches it.

Two other things go with it, from the same reading:

- The guard after `await api.abort(ref)` is worse in kind than an orphan.
  A click landing in that window kills the parent's running turn and then abandons the fork, so the user loses the turn and gets nothing back.
  The button says "Stop and fork", so they did ask for the stop — but not for the nothing.
- None of the intent guards except the one after `api.fork` has a test.
  A mutation run over `src/client` on 2026-09-10 removed the guard after `api.abort`, the guard after `api.forkPoints`, and `send()`'s `if (!edit && view.busy === "submitting") return;` one at a time, and all 460 client tests stayed green each time.

## Done when

The decision is recorded, whichever way it goes, and the guards that survive it are covered.

Decide what an abandoned fork should do — leave it (and say so where the guard is, so the next reader stops re-asking), delete it, or never create it by moving the fork call after the last window in which a click can arrive.
There is no delete-session route in `src/server/http/app.ts` today, so "delete it" is the expensive answer and is worth pricing before choosing.

Then, whichever was chosen:

- A test in `src/client/controller.test.ts` covers the `api.abort` window: it asserts what the abandoned-fork decision says should happen, and fails before the change.
- A test covers the `api.forkPoints` window the same way.

## Load-bearing

The choice is what to do about the orphan, not whether the guard should exist — the guard is what OW-mifuki was for, and reverting it re-opens the yanked-selection defect that card closed.
