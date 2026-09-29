---
labels: [question]
---

# Decide whether the server says on the stream that a handle has ended, retiring the listing both clients read to infer it

Filed 2026-09-29 while executing OW-pihuko, by the sibling rule in `card execute`: its adversarial reader named the browser's new drop as a check at the listing site whose owner is elsewhere, and named cases it misses.

## Where the fact lives and where it is read

The server knows a handle has ended at the moment it happens: `#remove` and `broadcaster.forget` in `close()`, `#forkOnto` and `disposeAll()` in `src/server/http/session-manager.ts`.
It says nothing under that handle on the event stream.
Both clients instead infer the end from a later listing: `replaceSessionSummaries` in `src/client/session-state.ts` drops a view held when the listing was asked whose handle the listing lacks (OW-pihuko) and, beside it, a view paired by ref with a `detached` summary (OW-fihuma); `dropDead` in `src/emacs/helper.ts` does the same for the helper's attachments (OW-yibijo).
`detach()` in `src/client/controller.ts` also drops its own view locally.

D25 in `docs/DESIGN.md` chose this on 2026-09-28: "The listing-based dropping at every `sessions-changed` while the stream is up stays in both clients, since another client's close is still a real case".
So this card is a question against a recorded decision, not a defect.

## What the inference misses

1. `close()` sends `sessionsChanged()` only after `await disposal.promise`, so for as long as the adapter takes to dispose -- up to the kill grace -- a session another client closed still shows `live` here, and a Send gets 409 `not_attached`.
   `#forkOnto` sends it right after `forget`, so a fork elsewhere does not have this window.
2. When the listing that `sessions-changed` asks fails, nothing asks again until the next `sessions-changed`: `listSessions` in `src/client/controller.ts` swallows the error for a non-surfacing caller, and `dropDead`'s docblock says "A failed listing drops nothing".
   A dead view then stays live indefinitely on a quiet server.
3. The listing is a whole-table read each time, taken only to learn which handles went.

## The proposal to decide

A per-handle terminal event on the ordered stream -- sent where `forget` runs, before the handle is forgotten -- that the reducer in `src/client/session-state.ts` and the helper apply to drop exactly that view or attachment.
Were it adopted, what it would retire must be named in the decision: the missing-handle drop and the detached-by-ref drop in `replaceSessionSummaries` (keeping OW-fihuma's summary restore only if something still needs it), `dropDead`'s eviction, and `detach()`'s local drop; and D25's sentence quoted above changes.
Whatever the answer, the Emacs parity rule in `AGENTS.md` ("Both clients") governs any implementation cards it files.

## Done when

The decision is recorded in `docs/DESIGN.md`, as an amendment to D25 or a new decision, and, if it adopts the event, its implementation cards are filed -- one carrying the event onto both wires and one per client blocked by it, the Emacs one labelled `emacs`.
Whichever way it goes, the record says what becomes of cases 1 and 2 above.
