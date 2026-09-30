---
labels: [unverified, sweep-0929]
closed: done
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

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) checked this card's claims and found them to hold: `addClient` runs inside the stream's `start` in `src/server/http/app.ts`, and `list()` in `src/server/http/session-manager.ts` reads the live overlay only after awaiting the index.
It proposes a third way to close the window, beside the two above: the server sends `sessions-changed` straight after the opening snapshots on every open, and the client lists only on `sessions-changed`.
The listing then always follows registration, and `start()`'s own listing, the `opened` and `listedOk` booleans gating it in `src/client/controller.ts`, and D21's "Not on the first open" paragraph all go, for the same number of requests.
The Emacs helper opens the same stream; say in the close note what the change means for it.
Which of the three to take is this card's call.

## Close note

Took the first of the card's three ways: every open of the event stream lists, the first included, in `handlers.onOpen` in `src/client/controller.ts`, and the `opened` and `listedOk` booleans that gated it are gone.
It closes the window without a server change because `openEventStream` in `src/server/http/app.ts` registers the client with `broadcaster.addClient` inside the `ReadableStream`'s `start`, before the `Response` exists, so by `onopen` the tab is registered and a listing asked there reads the live overlay after registration.
The third way (the server sends `sessions-changed` after the opening snapshots) was passed over as a wire change to both clients for a window the browser can close alone.
`start()` keeps its surfaced listing, which paints the sidebar without waiting on the stream and reports a server that is away, so a page load costs one more `GET /api/sessions`; a first open landing mid-listing costs the same one, as OW-sabova's owed listing.
D21 in `docs/DESIGN.md` is retitled "..., and so does the first open", carries an "Amended by OW-dajove" line, and its "Not on the first open" paragraph is rewritten: the "would list a second time" claim and the two-booleans sentence are gone.
Emacs helper: unchanged and never had the window; its `sessions/list` handler in `src/emacs/helper.ts` awaits `openStream()` before `api.listSessions`, and that is its only listing, asked only when Emacs asks.
Verified: the renamed test in `src/client/controller.test.ts`, "lists again on a first open that lands after the startup listing, and shows what that listing answers", failed against the old gate (1 listing, not 2) and passes now; "lights the row of a session attached while a listing was in flight (OW-sabova)" and the detach-before-first-turn test were adjusted for the extra startup listing; `bun run check` passed (1582 tests).
Not covered by any test: the server-side ordering itself, that a client is registered by the time `onopen` fires; it rests on reading `openEventStream`.
