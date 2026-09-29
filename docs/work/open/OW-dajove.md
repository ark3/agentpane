---
labels: [unverified]
---

# D21 skips the listing at a first open that lands after the startup listing, but a change made between that listing's live read and the stream's registration reaches the tab by neither

Found 2026-09-29 by OW-sabova's adversarial read; not reproduced, only read from the code.
In service of D21 in `docs/DESIGN.md` ("A re-established event stream asks for a session listing, and the first open does not"), whose "Not on the first open" paragraph holds that an open landing after the startup listing resolved would list a second time for nothing.

## The ordering

`start()` in `src/client/controller.ts` opens the event stream and then lists, and `onOpen` there lists on the first open only while `listedOk` is false (`if (opened || !listedOk)`).
On the server, `openEventStream` in `src/server/http/app.ts` registers the SSE client with `broadcaster.addClient` inside the stream's `start`, and `list()` in `src/server/http/session-manager.ts` reads the live overlay only after awaiting the index read, which D21 times at about 0.16-0.24s.
So the registration normally precedes the listing's live read, and every change after that read is broadcast to the tab.
The case left is a stream request slow enough that the listing's live read comes first: a change between that read and `addClient` is in neither the listing's answer nor any broadcast the tab receives, and the open, landing after the listing, is skipped by the gate.
Concrete miss: another client attaches X in that window; the opening snapshots give this tab a live view of X while its row reads `detached`, which is OW-sabova's symptom, and if this tab then attaches X the already-attached path in `session-manager.ts` broadcasts a snapshot but no `sessions-changed`, so nothing re-lists.

Since OW-sabova, a first open that lands while the startup listing is still out is owed a listing after it; that is a byproduct of every mid-listing call being owed one, and it is the case the server's ordering already usually covers.

## Done when

Either a controller test in `src/client/controller.test.ts` plus a change that makes the first open list whenever the stream registered after the startup listing's live read could have happened (and D21's "Not on the first open" paragraph and the `onOpen` docblock say so), or a recorded argument in D21 showing why the window cannot occur, citing the server code that orders `addClient` before `list()`'s live read.
Whichever it is, D21's "for nothing" sentence ends up true or gone.
