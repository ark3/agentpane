---
labels: [deferral]
closed: done
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

**Amended 2026-09-16 during execution: the load-bearing claim above is false, and was measured false.**
`onerror` does fire for both cases, but `source.readyState` read inside the handler separates them.
Measured on the home server on 2026-09-16 against Chromium 151.0.7922.34 driven by Playwright 1.62.1 -- the vehicle's `chromium-headless-shell` build and Playwright's default build agreed on every value:
a 404 and a 200 carrying `Content-Type: text/plain` each fire exactly one `error`, with `readyState === 2` (CLOSED) and no further `open`;
a stream that opened as `text/event-stream` and was then cut fires `error` with `readyState === 0` (CONNECTING) and re-opens, indefinitely.
Two caveats the measurement also turned up.
A reconnect answered 503 reads 0 on the first error and 2 on the second, so fatality is sometimes only knowable on a later error.
And a server process that has gone away entirely reads 0 forever, so "retrying against something that will never answer" is a case `readyState` does not name -- that one needs an attempt count or a deadline, and is not this card.

So the obvious fix the paragraph below ruled out is in fact available, and the repair chosen here is to take it: `defaultOpenEvents` already holds `source` at the line that calls `handlers.onDisconnect()`, so fatality is one comparison away, and `onDisconnect` carrying that bit is the whole of the plumbing.

Load-bearing, as amended: that a fatal close is detectable at `source.onerror` through `readyState`, and that nothing today acts on it.
Incidental: which repair is chosen.
The shapes available, none of them costed: poll while `connection` reads "reconnecting"; reconstruct the `EventSource` once fatality is known, which needs a timer the client currently has no equivalent of and which restores the stream itself rather than only the sidebar, since its `onopen` is what D21 re-lists on; or surface the fatal case in the indicator so Refresh becomes an instruction rather than a guess.

Done when a client that has seen a fatal close reaches a truthful sidebar without a gesture, pinned by a controller test that drops the stream, never re-opens it, and still sees freshened summaries -- red first.
If the decision instead is that a fatal close is the user's to resolve with Refresh, that closes this card too, recorded in the docblock at `handlers.onOpen` beside D21's own reasoning, and then the indicator's wording is the thing to fix.

## Close note

Fixed on `main` as e02faaf (implemented on a worktree branch as ca57b65).

The card's original load-bearing claim -- that `onerror` cannot tell a fatal close from a retryable drop -- measured false, and the card was amended with the measurement before dispatch (03e054b).
Measured on the home server on 2026-09-16, Chromium 151.0.7922.34 under Playwright 1.62.1, agreeing across the vehicle's `chromium-headless-shell` build and Playwright's default: a 404 or a `text/plain` body fires exactly one `error` at `readyState === 2` (`CLOSED`) with no further open; a stream cut mid-flight fires `error` at 0 (`CONNECTING`) and re-opens indefinitely; a cut whose retry is answered 503 reads 0 then 2, so fatality is sometimes only knowable on a later error.
Recorded in `docs/MANUAL_TESTING.md` under "What an `EventSource` error says about itself (OW-dekuri)" and pinned in the vehicle as `e2e/event-stream.spec.ts`.

So the repair is the one the original card ruled out.
`EventHandlers.onDisconnect` now carries `fatal`, which `defaultOpenEvents` reads off `source.readyState === EventSource.CLOSED`; on a fatal disconnect the controller rebuilds the connection after `FATAL_STREAM_RETRY_MS` (5s -- above the browser's ~3s default for the drops it does handle, twelve requests a minute at worst against a server that never returns, one cycle to clear a restart), repeating while it stays fatal, closing the old connection first and cleared at `dispose()`.
No second healing path: a rebuilt stream that opens fires `onOpen`, and D21's re-list there is the healing, so the detach regression the card named -- the attached stripe left lit -- goes with it.
`connection` still publishes "reconnecting" for both cases; whether a fatal close deserves a fourth visible state was out of scope and stays unmade.

Red first, each confirmed: the controller test "rebuilds a fatally closed event stream until one opens, and heals with no user gesture" failed `expected 1 to be 2` against today's controller (re-run in the dispatching session with the `if (fatal)` branch stubbed out, same failure); "leaves a recoverable drop to the browser's own retry" was forced red by dropping the `fatal` gate, `expected 2 to be 1`; the api test "reports whether the native source is fatally closed at the disconnect" failed with the spy called with no args; the e2e spec was inverted to produce `Expected: 0 / Received: 2`, which is the measurement itself.
Green: `bun run check` 1110 tests in 50 files, 22.6s; `bun run test:browser` 22 passed, 1.1m -- both re-run in the dispatching session before landing.

Out of scope and filed as OW-vipito: a server that has gone away entirely reads `readyState === 0` forever, which is indistinguishable from a healthy retry, so that tab still sits in "reconnecting" with a stale sidebar. That needs an attempt count or a deadline, and may turn out to heal unaided the moment the server returns.
