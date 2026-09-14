---
labels: [deferral]
closed: done
---

# A failed turn/steer precondition reaches the user as raw wire error text

Filed 2026-09-13 from OW-pefawi, whose terms require it: "The mapping is not rejected as an idea, only as the fix for this window: it is worth having as a backstop for precondition failures nobody anticipated, and if the implementer wants it, it is a separate card and not this one."
OW-pefawi's implementer wanted it, in a narrower form than the "busy" mapping that card considered and rejected.

## The gap

`src/server/adapters/codex/adapter.ts`'s `submit()` sends `turn/steer` and does not catch its rejection:

    await client.request("turn/steer", { threadId, input, expectedTurnId: this.turnId });

`expectedTurnId` is one of several preconditions app-server enforces -- `resources/codex-protocol/v2/TurnSteerParams.ts` documents it prose-only, as "Required active turn id precondition. The request fails when it does not match the currently active turn", with no structured error code beside it.
Whatever app-server answers with therefore reaches the user as raw JSON-RPC error text, naming neither which precondition tripped nor the turn id the adapter tried.

Two windows that produced exactly that are now closed at the source -- compaction by OW-tifuha's guard, an already-interrupted turn by OW-pefawi's -- so nothing known reaches this today.
That is what makes it a deferral rather than a defect: it is a backstop for the precondition failure nobody has anticipated yet, and its value is that the *next* such window is legible on first sight instead of needing the protocol file read to diagnose.

## Not the "busy" mapping

OW-pefawi rejected translating a failed precondition into the adapter's "busy" error, and that reasoning stands: it spends a round trip to arrive where it started, and it leaves the adapter's notion of "busy" defined by app-server's error text.
The narrower thing wanted here does not classify the failure at all.
It catches the rejection and re-raises it with the adapter's own framing wrapped around app-server's message, naming the turn id that was sent as `expectedTurnId`, so the failure is greppable and self-describing rather than opaque.
A rejection is still a rejection; nothing is swallowed and nothing is retried.

## Done when

A test in `src/server/adapters/codex/adapter.test.ts` goes red first and green after: drive a `turn/steer` whose response is a JSON-RPC error, and assert the error the caller receives carries the adapter's framing and the attempted turn id alongside app-server's own text.
No such case exists in the suite today -- `configureHappyServer`, the fixture every adapter test builds on, has no failing-`turn/steer` path, so this needs one written.

## Close note

Landed as 89d2db2 on `main`.

`submit()`'s steer in `src/server/adapters/codex/adapter.ts` now wraps `client.request("turn/steer", ...)` in a try/catch that re-raises with the adapter's own frame: `codex adapter turn/steer rejected (expectedTurnId <id>): <app-server's message>`, off a new module-level `TURN_STEER_REJECTED_ERROR` const beside the other turn error strings.
Nothing is classified, swallowed or retried, so the "busy" mapping this card's parent rejected stays rejected.

Verified red first, by hand and not only by the implementer's report: with the catch stripped back to the bare `await client.request(...)`, the new test fails with `Received: "expectedTurnId does not match the active turn"` -- the raw wire text this card was filed about, arriving alone.
Green after, and `bun run check` passes at 49 files / 1065 tests.

The test is `frames a rejected steer with the adapter and the turn id it sent (OW-gemawu)` in `src/server/adapters/codex/adapter.test.ts`, and the fixture gained a `failSteer?: string` option on `HappyServerOptions` modelled on the existing `failCompact` -- `turn/steer` emits a JSON-RPC error instead of echoing `expectedTurnId` when it is set.
That option is the reusable half: any later test needing a rejected steer has it now.

Two things the implementer added that review removed before the commit landed, both unasked-for by this card and unsupported by the code: `{ cause: error }` on the thrown error, which nothing in `src/` reads (there is no other `{ cause }` in the codebase), and an `error instanceof Error ? ... : String(error)` ternary whose false branch is unreachable -- `CodexClient.request` rejects only with an `Error`, since `Pending.reject` in `src/server/adapters/codex/jsonrpc.ts` is typed `(error: Error) => void` and every path reaching it normalizes first. The cast that replaced the ternary carries that citation in its comment.

Filed OW-manulu from this work: `compact()` re-raises a failed `thread/compact/start` with the same unframed wire text, the one other adapter request a user gesture can drive into a rejection.
