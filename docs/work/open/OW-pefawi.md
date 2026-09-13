---
labels: [defect]
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
