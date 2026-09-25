---
labels: [defect]
closed: done
---

# A snapshot read while a Pi fork is in flight can still carry the fork's transcript under the parent's ref

OW-nikogo, filed 2026-09-24 under D24, closes this: the test below is its first done-condition, and the fix is the adapter's identity event rather than a second guard beside OW-zovaye's.

Noticed 2026-09-22 by OW-zovaye's implementer, reasoned from `src/server/http/session-manager.ts`; not reproduced.
In service of a Pi fork leaving its parent's view as it was, in every client — OW-zovaye closed the push path and left the pull path.

OW-zovaye made `#onUpdate` drop an update while `session.forking > 0` and the adapter's ref has already moved off `session.ref` (the comment beginning "An update from inside a fork").
The snapshot source the manager hands the broadcaster (the lambda returning `adapter ? adapter.getState() : null`, near the top of `SessionManager`) has no such check: it resolves the parent's ref to the container still keyed there and reads `getState()`, which inside `PiAdapter.fork` (`src/server/adapters/pi/process.ts`, after `hydrateMessages()`) already holds the fork's rewound transcript.
So in the gap between the adapter moving and `fork()`'s `finally` re-keying, any of these sends the fork's transcript under the parent's ref: an attach of the parent from another client, a new event stream's opening snapshots (the parent's ref is still in `liveRefs()`), or a recovery attach after a missed update.
Also in that gap, and lower: `onRequest` and `onError`, wired in `#start`, key by `session.ref`, so an agent request or error the adapter raises there goes out under the parent's ref too.

The gap is short (Pi's `get_state` and `get_messages` round trips), so this is a narrow race, not a steady symptom.
Load-bearing: whatever closes it must not also hide the renames `#onUpdate`'s check deliberately lets through (a Claude `system init` id change moves the adapter's ref ahead of the container's with no fork in flight).

## Done when

A `session-manager` test with an adapter that moves its ref and rewinds its state inside `fork()`, while the fork is held, reads the parent's snapshot through the path an opening stream or attach uses and sees no rewound transcript under the parent's ref, red before the fix.
The `onRequest`/`onError` case is either covered by the same fix with a test, or a sentence in this card says why it cannot matter.

## Close note

Closed under OW-nikogo (2026-09-25), with the ownership change, not a second guard.
A Pi fork now announces its move through the adapter's `onRefChanged` right after the fork's `get_state`, and `SessionManager` re-keys the container onto the fork's ref there, before the model re-send and `hydrateMessages()` emit.
So a pull of the parent's ref in the window finds no container, and `onRequest` and `onError` go out under the fork's ref; OW-zovaye's `forking` count and `#onUpdate` guard are retired.
Test: `src/server/http/session-manager.test.ts`, "answers a pull of the parent's ref with nothing of the fork, and what the fork raises goes out under its ref (OW-nuzepi)", holding the fork after the move and pulling through `broadcaster.sendSnapshot` and `sendOpeningSnapshots(liveRefs())`; red on the pre-change manager (snapshot, error and request under the parent's ref), green after.
