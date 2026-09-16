---
labels: [deferral]
---

# A fatally closed event stream never re-lists, so nothing heals until the user presses Refresh

`src/client/api.ts` -- `defaultOpenEvents`, which wires the native `EventSource` and nothing else -- and `handlers.onOpen` in `src/client/controller.ts`, the re-list D21 put there.

D21 (OW-vukoku, 2026-09-16) heals state missed while the connection was down by re-listing at every open after the first.
That mechanism is `onopen`, so it covers exactly the drops the browser retries.
It does not cover a fatal one.
A native `EventSource` that reaches `CLOSED` -- which a non-2xx or a wrong content-type on `/api/events` produces, as against the network-level drop that `retry: 500` recovers from -- never fires `onopen` again.
`onDisconnect` is `source.onerror`, which fires for both cases and cannot tell them apart, so the client publishes `connection: "reconnecting"` and waits forever on an open that will not come.
Nothing then moves `status` or `updatedAt` until the user presses Refresh.

Deferred rather than fixed because the surrounding state is already broken when it happens: with the stream fatally down there is no streaming, no snapshots and no `sessions-changed` either, and the connection indicator reads "reconnecting" throughout, so a stale sidebar is not what the user notices first.
D21's decision paragraph records the frequency bound it does defend; this is the case outside it.

Worth naming that this is not a regression from D21 in general but is one for a single gesture: before D21, `detach()` carried its own `void refreshSessions(false)` over HTTP, which succeeded whatever the SSE was doing (OW-lejahi).
D21 removed that call for the ordinary path -- the virtual exit kept it, for a different reason -- so a detach with a fatally closed stream now leaves the attached stripe lit where one commit earlier it did not.
That one gesture is the whole of the regression, and it is what makes this worth a card rather than a comment.

Load-bearing: that `onerror` cannot distinguish a retryable drop from a fatal close, which is what rules out the obvious fix of re-listing on disconnect instead.
Incidental: which repair is chosen.
The shapes available, none of them costed: poll while `connection` reads "reconnecting"; reconstruct the `EventSource` on a disconnect that does not re-open within some window, which needs a timer the client currently has no equivalent of; or surface the fatal case in the indicator so Refresh becomes an instruction rather than a guess.

Done when a client that has seen a fatal close reaches a truthful sidebar without a gesture, pinned by a controller test that drops the stream, never re-opens it, and still sees freshened summaries -- red first.
If the decision instead is that a fatal close is the user's to resolve with Refresh, that closes this card too, recorded in the docblock at `handlers.onOpen` beside D21's own reasoning, and then the indicator's wording is the thing to fix.
