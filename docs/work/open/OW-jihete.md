---
labels: [change]
---

# A mid-turn Claude prompt is queued silently, which D16 requires be a rejection instead

`src/server/adapters/claude/adapter.ts` — the module docblock's "CLI queues stdin messages sent mid-turn, so `submit()` does not gate", and `submit` at `:188-202` ("Admission is the stdin write; the CLI queues messages sent mid-turn"); `src/server/adapters/claude/reducer.ts`, `beginTurn`.

D16 makes a mid-turn `submit()` mean *steer*, and requires an adapter whose backend cannot steer to reject rather than do something else.
Claude Code has no steer primitive — the prompt is a line written to stdin — and what it does instead is the thing D16 names as the one unacceptable answer: it silently downgrades to a follow-up.
The write succeeds, `submit()` resolves, and the prompt lands after the running turn without anything at the wire distinguishing that from having been accepted into it.

So this adapter should throw when `this.turnActive`, the way Codex's `TURN_ACTIVE_ERROR` guard does, and the module docblock's claim that `submit()` "does not gate" becomes false and must go with it.
The route already turns the throw into a 500 and `controller.ts`'s `submit` clears the draft only on success, so the user keeps their text.

**This likely moots OW-toyeru**, which is the transcript-ordering defect of exactly the queued mid-turn prompt this change stops producing — its echo lands at write time, before the running turn's remaining assistant messages. If nothing can be queued mid-turn, nothing is misordered. Do not assume it: OW-toyeru also records that the first `result` drops `isStreaming` to false while a queued turn is pending, and whether that second half survives depends on whether any path still reaches the CLI's queue. Settle it explicitly and close OW-toyeru `--moot` with this card's id, or leave it open having said which half survives. OW-toyeru has been re-pointed to wait on this card rather than on OW-rifezo.

## Done when

- An adapter test in `claude/adapter.test.ts` submits while `turnActive` and asserts it rejects; it fails before the change.
- The module docblock no longer says `submit()` does not gate, and says why it now does, citing D16.
- OW-toyeru is explicitly settled, in either direction, with the reasoning recorded rather than inferred.

**Added 2026-09-09 by the adversarial read of D16:** the gate proposed above tests `this.turnActive`, and that is the same flag `adapter.ts:418` clears on the first `result` — which is precisely the accuracy OW-toyeru's second half puts in question.
So the gate inherits that question rather than standing clear of it: if `turnActive` goes false while a queued turn is still pending, a prompt sent in that window passes the gate and is queued after all.
Settle the flag's accuracy as part of this card, not after it.
