---
labels: [defect, emacs]
closed: moot
---

# The Emacs helper sends no sessions/changed when its event stream's first open fails and a later one succeeds, so a picker opened while the server was down never re-lists

Found by the adversarial read of OW-mareju on 2026-09-27; it predates that card, which only made it visible.

In `src/emacs/helper.ts`, `openStream`'s `onOpen` counts successful opens in `opens` and returns at `opens === 1` before notifying `sessions/changed` and running `dropDead`, on the premise that the first open is not a reconnect.
When the stream's first open fails -- the server is down when the first `sessions/list` or `sessions/attach` opens it, and `src/emacs/sse.ts` reports a rejected fetch or a non-200 as `onDisconnect(true)` -- the open that ends that outage is still `opens === 1`.
So Emacs hears `stream/changed` `"connected"` (OW-mareju) and no `sessions/changed`: a picker whose `sessions/list` failed while the server was away stays empty until `g`, and any listing change during the outage is lost.

The browser met the same case and fixed it with `listedOk` in `src/client/controller.ts`; the docblock above `handlers.onOpen` there ("`listedOk` and not the open count, because the predicate is that a listing has *landed*") is the reasoning to follow, and OW-vukoku is the closed question that made the browser re-list on reconnect.
Load-bearing: the predicate that decides whether an open re-lists must be "has the stream ever been up and a listing landed", not "is this the first successful open"; whether the helper tracks a landed listing or an ever-failed open is this card's to choose.

The sentence in `src/emacs/protocol.ts`, the `stream/changed` entry, that states the exception ("except after a first open that failed", or however OW-mareju's review worded it) becomes false once this lands, and the change retires it; grep `src/emacs/helper.ts`'s module docblock for the same exception.

Done when a test in `src/emacs/helper.test.ts` whose event source fails the first open and then succeeds (the `failing` counter on `eventSource()` that OW-mareju added) sees `sessions/changed` after `stream/changed` `"connected"`, red before the change and green after.

## Close note

Moot under D25 (2026-09-28): OW-mepufi makes the helper exit when its first open fails or its stream drops, so there is no later successful open for a `sessions/changed` to be missing from.
