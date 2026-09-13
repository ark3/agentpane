---
labels: [defect]
closed: done
---

# A Codex submit between abort and turn/completed steers a turn that is being torn down

Found by the adversarial read of OW-tifuha, and a consequence of it: a legibility regression, narrower than OW-roveze and separate from it.

`src/server/adapters/codex/adapter.ts`'s `abort()` sends `turn/interrupt` and does not clear `this.turnId`; the only clear is in `onServerMessage`'s `turn/completed` arm.
Between the interrupt resolving and that notification arriving, `submit()` sees a non-null `turnId` with no compaction showing, so it takes the steer path and sends `turn/steer` with `expectedTurnId` naming a turn app-server is tearing down.
`resources/codex-protocol/v2/TurnSteerParams.ts` documents `expectedTurnId` as a precondition that "fails when it does not match the currently active turn", so the user gets an opaque wire error.

Stop-then-immediately-send is an ordinary gesture, so the window is reachable by hand.
Before OW-tifuha the same window produced `TURN_ACTIVE_ERROR`, which is legible; nothing here is newly *broken*, only newly illegible.
That is why this is filed rather than fixed inside OW-tifuha: two answers were open, a flag `abort()` sets and `turn/completed` clears, or mapping a failed `turn/steer` precondition back to a well-defined "busy" as a general fix covering more than this one window.

**Decided 2026-09-13: the flag.**
Sending a request the adapter can predict will fail, in order to translate its failure, spends a round trip to arrive where it started, and it leaves the adapter's notion of "busy" defined by app-server's error text rather than by the adapter.
The Done-when below already assumed this -- "no `turn/steer` reaches the wire" rules the mapping out -- and now says so rather than deciding by omission.

The mapping is not rejected as an idea, only as the fix for this window: it is worth having as a backstop for precondition failures nobody anticipated, and if the implementer wants it, it is a separate card and not this one.

The compaction case is already guarded — `submit()` refuses to steer while `this.reducer.getState().compaction` is set, with the test "refuses to steer a compaction turn, and sends nothing on the wire (OW-tifuha)" in `src/server/adapters/codex/adapter.test.ts`. That guard does not reach this one.

## Done when

A test in `src/server/adapters/codex/adapter.test.ts` goes red first — abort a turn, then `submit()` before emitting `turn/completed`, asserting no `turn/steer` reaches the wire and the caller gets the adapter's own busy error rather than app-server's — and green after.

## Close note

Fixed by the flag the card decided on, in `fdbc9e3` on `main`.

`src/server/adapters/codex/adapter.ts` gains `interruptedTurnId`, set by `abort()` *before* awaiting `turn/interrupt` -- the turn stops being steerable the moment app-server sees the interrupt, not when the response lands, so setting after the await would leave the earlier half of the window open.
`submit()` refuses with a new `TURN_INTERRUPTED_ERROR` ("codex adapter cannot submit while an interrupted turn is ending") ahead of the steer path, guarded as `this.turnId && this.interruptedTurnId === this.turnId`.
A distinct constant rather than reusing `TURN_ACTIVE_ERROR` because the turn is no longer active in that window; nothing in the codebase branches on either string, both only surface to the user.
`turn/completed` clears the field beside its existing `turnId` clear, and `finishDisposal()` clears it with the rest of the turn state.

Two tests in `src/server/adapters/codex/adapter.test.ts`, both shown red before green by mutating the fix in the tree:

- "refuses to steer a turn it has already interrupted, and sends nothing on the wire (OW-pefawi)" -- with the guard deleted, `submit()` resolves instead of rejecting and puts `turn/steer` with `expectedTurnId: "turn-1"` on the wire, which is the defect exactly.
- "admits a submit once the interrupted turn completes (OW-pefawi)" -- the strand guard. It survives deleting either release mechanism alone, because the code carries two that are independently sufficient: the `turn/completed` clear, and the guard's `=== this.turnId` conjunction, which makes a stale id inert once `turnId` moves (ids are not reused). Deleting both turns it red with the adapter refusing every later submit forever. Worth knowing for anyone simplifying either line: neither is load-bearing while the other stands.

`bun run check` green whole (1038 tests, ~21s). Server-side only, so `test:browser` was not run.

The card's conditional fired: its implementer wanted the precondition mapping it set aside, in a narrower form than the "busy" classification the card rejected -- framing a failed `turn/steer` with the turn id sent, rather than classifying it. Filed as **OW-gemawu** (`deferral`), committed in `f6f95e4`.

Noticed and not done: `compact()`'s guard (`turnBusy || turnId`) happens to cover this window too, because `turnId` is still set there -- correct by accident rather than by statement, and it would silently lose that cover if anything ever cleared `turnId` at interrupt time. Not changed, and no card filed; recorded here because the coupling is invisible at either site.
