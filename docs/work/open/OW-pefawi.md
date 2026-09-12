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
That is why this is filed rather than fixed inside OW-tifuha: the right answer may be a flag `abort()` sets and `turn/completed` clears, or it may be that mapping a failed `turn/steer` precondition back to a well-defined "busy" is the general fix and covers more than this one window. Nobody has decided.

The compaction case is already guarded — `submit()` refuses to steer while `this.reducer.getState().compaction` is set, with the test "refuses to steer a compaction turn, and sends nothing on the wire (OW-tifuha)" in `src/server/adapters/codex/adapter.test.ts`. That guard does not reach this one.

## Done when

A test in `src/server/adapters/codex/adapter.test.ts` goes red first — abort a turn, then `submit()` before emitting `turn/completed`, asserting no `turn/steer` reaches the wire and the caller gets the adapter's own busy error rather than app-server's — and green after.
