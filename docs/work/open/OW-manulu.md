---
labels: [deferral]
---

# A rejected thread/compact/start re-raises app-server text unframed

Filed 2026-09-13 from OW-gemawu's execution, where it surfaced as the obvious sibling of the steer framing that card asked for.

`compact()` in `src/server/adapters/codex/adapter.ts` already catches its request's rejection, but only to undo the optimistic reducer state:

    try {
        await client.request("thread/compact/start", { threadId });
    } catch (error) {
        this.applyEffects(this.reducer.cancelCompaction());
        throw error;
    }

The `throw error` re-raises app-server's own text with nothing around it, so a failed compaction reaches the user naming neither the adapter nor the thread it was attempted on -- exactly the shape OW-gemawu closed for `turn/steer`, and the only other request in this adapter that a user gesture can drive into a rejection.

## Why a deferral and not a defect

Nothing known reaches it today: `compact()`'s own guards refuse while a turn is pending or active, and no window has been observed where app-server rejects a compaction the adapter was willing to send.
Its value is the same backstop value OW-gemawu's was -- the next such window is legible on first sight -- and it is worth less than that one was, because a compaction failure is one request with one obvious subject where a steer failure is a precondition set documented prose-only.

The framing is deliberately *not* worth generalizing into a helper across the two sites until there is a third: OW-gemawu's frame carries `expectedTurnId` because that is the precondition at issue there, and a shared wrapper would have to take the naming as a parameter, which is the whole of the code.

## Done when

`src/server/adapters/codex/adapter.test.ts` grows a case that goes red first and green after, driving a failing `thread/compact/start` -- the fixture already supports it via `configureHappyServer`'s `failCompact` option -- and asserting the error the caller receives carries the adapter's own framing alongside app-server's message.
The existing `failCompact` tests assert the reducer's compaction state is rolled back; this is about the error text those tests let through.
