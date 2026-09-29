---
labels: [change, sweep-0929]
---

# The server sends nothing under a handle it lets go, so add an unsequenced ended event where close() and #forkOnto forget it, and move close()'s sessions-changed to the same run

Filed 2026-09-29 by OW-zavehi, whose decision is D26 in `docs/DESIGN.md`; read points 1 to 3 and "What it amends" there before starting.
This card carries the event onto the HTTP stream and into the shared reducer; the browser's and the helper's retirements are their own cards, blocked by this one, and the Emacs wire needs nothing new, since `session/detached` in `src/emacs/protocol.ts` already says it.

## What is there now

`close()` in `src/server/http/session-manager.ts` takes the container out (`#remove`), unsubscribes and calls `this.broadcaster.forget(session.handle)` in one synchronous run before its first await, then sends `this.broadcaster.sessionsChanged()` only after `await disposal.promise`, and only when it found a container.
`#forkOnto` in the same file does `#remove(parent)`, `forget(parent.handle)` and `sessionsChanged()` synchronously.
`forget` in `src/server/http/broadcaster.ts` only deletes the handle's counter in `#seq`; `#address` numbers every per-handle event, and `formatSseFrame` frames each as one `data:` line.
`ServerEvent` in `src/shared/protocol.ts` has six per-handle arms with `seq` -- `snapshot`, `upsert`, `status`, `error`, `error-cleared`, `notice` -- and one stream-level arm, `sessions-changed`.
`reduceServerEvent` in `src/client/session-state.ts` is shared by the browser and by the helper in `src/emacs/helper.ts`.

## What to build

- An `ended` arm on `ServerEvent`, carrying `session` and `handle` and no `seq` (D26 point 2 says why: a `seq` would recreate the counter `forget` drops, which is what the comment in `submit` warns of).
- The broadcaster sends it under the handle without touching `#seq`.
- `close()` sends it where it forgets the handle, in the same synchronous run, and sends its `sessions-changed` there too instead of after the disposal; a close that found no container still sends neither.
- `#forkOnto` sends it for the parent's handle where it forgets it; it names no fork, so OW-suhoto's rule that the fork's container broadcasts nothing under the parent's handle stands, but a client that did not fork and held the parent live now loses that view and falls to the parent's preview, its selection standing.
- `disposeAll()` sends nothing (`app.close()` in `src/server/http/app.ts` closes every stream first).
- `reduceServerEvent` drops the view under the handle on `ended`, whatever its `seq` stands at, and reports nothing for a handle it holds no view of.

## Records that change with it

The docblocks of `#forkOnto` ("`sessionsChanged` alone") and of `ServerEvent`, and `close()`'s comments on when `sessions-changed` goes.
`docs/WORKSTREAMS.md`'s sentence "all a fork tells other clients is `sessions-changed`" gains the parent's `ended` on Pi.
D3's bulleted list of events gains `ended`, and D11's "with the `seq` and session id at the top level" says `ended` carries no `seq`; D26 lists both as amended but leaves their text to this card.
`#accept` in `src/server/http/testing/sse-client.ts` reads `event.seq` on every event but `sessions-changed` and counts gaps from it; it must take `ended` as it takes `sessions-changed`, or it will not typecheck and will count a gap.

## Tests this changes on purpose

- In `src/server/http/session-manager.test.ts`, "moves the adapter onto the fork's container, naming the fork under nothing of the parent's…" asserts no event carries the parent's handle, and "sends nothing under the parent's ref, and the fork's attach snapshots the rewound transcript" and its "…when the fork fails after emitting" sibling match events by `event.session`; each now sees the parent's `ended` and excepts it.
- In `src/server/http/vertical-slice.test.ts`, "leaves a browser that did not fork on the parent it was reading (OW-suhoto)" asserts the onlooker keeps the parent's live view; under D26 that view goes, and the test asserts the onlooker keeps the selection on the parent with no live view instead.

## An interim the browser must not show

Until OW-lilami lands, `detach()` in `src/client/controller.ts` clears a selection with nothing on disk only after `api.close` resolves, which waits out the disposal; `ended` now drops the view before that, so the pane goes detached-loading and `loadPreview` fetches the empty preview, breaking what `detach()`'s comment promises ("the detached-loading pane in between never asks for that preview").
This card keeps that promise, by whatever means the implementer finds smallest; OW-lilami retires the exit and the means with it.

## Done when

Tests red first, then green:
- in `src/server/http/session-manager.test.ts`, a close of an attached session writes `ended` under its handle, and `sessions-changed`, before the adapter's disposal settles (`holdDispose` in that file holds it open); a close of a ref with no container still writes neither, which passes today and pins it;
- a Pi fork (`#forkOnto`) writes `ended` under the parent's handle and no event under the parent's handle after it;
- in `src/client/session-state.test.ts`, `ended` drops the view under its handle whether its handle's last `seq` was contiguous or not, and leaves other views alone;
- in `src/client/controller.test.ts`, a `detach()` of a session with nothing on disk whose `ended` lands before the close answers never issues a preview read.
`bun run check` passes.
