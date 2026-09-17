---
labels: [deferral]
---

# A stream retrying against a server that is gone reads the same as a healthy retry

Found while executing OW-dekuri, which rebuilds a fatally closed event stream, and named this as the case it deliberately does not handle.

Measured on the home server on 2026-09-16, in Chromium 151.0.7922.34 under Playwright 1.62.1 (`docs/MANUAL_TESTING.md`, "What an `EventSource` error says about itself"): with the server process gone entirely, a native `EventSource` fires `error` at `readyState === 0` (`CONNECTING`) every retry interval, forever.
That is byte-for-byte what a healthy retry against a briefly cut stream reports, so `onDisconnect(fatal)` in `src/client/api.ts` -- which reads `source.readyState === EventSource.CLOSED` -- answers `false` for both, and `scheduleReconnect` in `src/client/controller.ts` correctly declines to act.
A tab left open against a stopped server therefore sits at `connection: "reconnecting"` indefinitely with a sidebar that never moves, which is the same user-visible end state OW-dekuri closed for the fatal case.

Nothing is wrong with what OW-dekuri built: rebuilding here would race the browser's own retry, which is why that card's repair is keyed on `CLOSED` and stops there.
Telling this case apart needs a different lever -- an attempt count, or a deadline on how long `reconnecting` may stand without an `onOpen` -- and the client carries neither today.
Deferred because the server being gone is a state the user can usually see for themselves, and because the D21 re-list it would trigger cannot succeed either while the server is down: the healing this would buy arrives only at the moment the server returns, which is also the moment the browser's own retry succeeds and fires `onOpen` unaided.
That last point may in fact make this a non-problem; establishing it either way is the first work on this card.

Load-bearing: that `readyState` does not name this case, and that the browser's own retry does eventually heal it if the server ever returns.
Incidental: whether the lever is a count or a deadline.

Done when it is settled whether a stopped-and-restarted server heals unaided -- a controller or e2e test that drops the stream at `CONNECTING`, leaves it down, brings it back, and asserts the sidebar freshens with no gesture.
If it heals, that closes this card as moot with the evidence recorded beside `onDisconnect` in `src/client/controller.ts`, where OW-dekuri's reasoning already sits.
If it does not, the remaining gap is a deadline on `reconnecting`, and the indicator's wording is the other half.
