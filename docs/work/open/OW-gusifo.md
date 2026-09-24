---
labels: [change]
---

# A resolved ServerRequest has no wire event, so the client can never retract one — which is what blocks declining a request nothing can answer

D2a decided on 2026-09-11 (OW-yikoyo) that a request the browser cannot answer is declined rather than held.
This card is that decision's implementation, and the wire gap below is why it is one card rather than a two-line change.

`src/shared/protocol.ts` (the `ServerEvent` union), `src/server/http/broadcaster.ts`, `src/server/http/session-manager.ts` (`#pendingRequests`), `src/client/session-state.ts` (the `request` arm of `reduceServerEvent`), `src/server/adapters/codex/adapter.ts` (`applyEffects`, the `"request"` and `"request-resolved"` cases).

## Why the obvious implementation is wrong

Declining at arrival without publishing kills a tested subsystem: the request namespace per adapter lifetime, the typed reverse mapping for pre-adoption requests, wire-id scoping across sessions, and numeric-versus-string wire ids all become unreachable, and OW-futewo's `issuerThreadId` with them.
That was measured, not guessed -- it takes eight tests in `src/server/adapters/codex/adapter.test.ts` red, and they become meaningless rather than adaptable.
OW-bijera needs that machinery working, so tearing it down now is rework booked in advance.

Declining *and* publishing is worse, and this is the part to understand before starting.
`reduceServerEvent`'s `request` arm appends to `view.requests` and nothing anywhere removes from it.
So a published-then-answered request leaves `App.svelte`'s warning standing -- "The agent is blocked on a request agentpane cannot answer ... end the session to clear it" -- over a turn that carried on without it.
Today that warning is at least true. That version makes it a lie that never clears.

## What is actually missing

`ServerEvent` has `request` and nothing that retracts it.
No client is told a request stopped being pending: not the one that answered it, not a second client watching, and not one watching Codex auto-approve.
`src/server/adapters/codex/reducer.ts` already emits a `request-resolved` effect for that last case and `applyEffects` consumes it to clean its own maps and emits nothing outward, so the detection exists and the wire does not.

## Shape

Publish the request as now, answer it at arrival, and broadcast the retraction, so the warning appears and clears rather than standing.
Whether the retraction is its own `ServerEvent` variant or a field on an existing one is the implementer's call; what matters is that a client which missed the middle of the exchange converges.
Amended 2026-09-24 after OW-bipume landed: the server now holds each session's pending requests (`ManagedSession.requests` in `src/server/http/session-manager.ts`), every `snapshot` carries them, and a client replaces its `requests` from the snapshot rather than preserving its own, so OW-1's preserve rule no longer describes the code.
A request answered through the reply route already leaves the server's copy (`clearRequest`) and so the next snapshot, but no event retracts it live.
A request Codex resolves itself still reaches nobody: `applyEffects` consumes `request-resolved` and tells the manager nothing, so the server keeps holding it, every later snapshot re-sends it, and since OW-bipume not even a page reload clears the warning or re-enables Tools -> Detach.
So the retraction has to reach the manager's held `requests` as well as the wire, and a snapshot is then a sufficient convergence path for a client that missed the event.

The decline shape comes from `DECLINE_RESPONSES` where the kind has one, and a JSON-RPC error where it does not, which is what OW-nujawi already does for unknown kinds; this card makes the known kinds behave the same way with a proper "no" instead of an error.

## Done when

A known approval kind arriving is answered with its decline shape, the turn is not left blocked, an error naming the kind reaches the client, and the pending request is retracted so no warning survives the exchange -- watched red first, since today it is held pending.

The eight correlation tests are rewritten rather than deleted: the wire-id scoping, the numeric-versus-string handling and the per-lifetime namespace are all still exercised, now through the auto-answer path instead of through `reply()`.
If any of them cannot be rewritten to cover the same logic, say which and why in the close note -- that is the signal that this card removed coverage rather than relocating it.

`docs/DESIGN.md` D2a's closing paragraph names this card as the gap's owner; update it to say the gap is closed.
