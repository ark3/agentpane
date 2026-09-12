---
labels: [change]
---

# The Codex adapter rejects a mid-turn prompt though `turn/steer` sits unused in the generated bindings

`src/server/adapters/codex/adapter.ts` — `TURN_ACTIVE_ERROR` defined at `:80` and thrown from `submit` at `:292`; `resources/codex-protocol/v2/TurnSteerParams.ts`; `resources/probes/codex_turn_probe.py`.

D16 makes a mid-turn `submit()` mean *steer* on every backend that can steer.
Codex can, on paper, and does not.

`TurnSteerParams` is generated into the bindings and carries `{ threadId, clientUserMessageId?, input, expectedTurnId }`, where `expectedTurnId` is documented in the binding itself as a "required active turn id precondition. The request fails when it does not match the currently active turn."
Nothing in `src/` calls `turn/steer` — the grep is empty — so today's rejection is the adapter's own choice made before the contract said anything, not a limit of the protocol.
The adapter already tracks what the call needs: `this.turnId` is the field the `TURN_ACTIVE_ERROR` guard tests.

**Nothing has run `turn/steer` live.** Its presence in generated bindings is not evidence that it works, what it does to the transcript, or what events come back — the same gap D15 was written around on a different Codex call. Verify before wiring, and record it.
This needs no work laptop: only Pi is confined there, and `codex` runs on the home server (`AGENTS.md`, "Evidence").

## Done when

A probe — extend `resources/probes/codex_turn_probe.py` — starts a thread, drives a long turn, and fires `turn/steer` against the active `turnId` while it streams, recording what the response is, what items arrive, and whether the steered text lands inside the running turn or opens a new one. That observation goes to `docs/MANUAL_TESTING.md`.

Then, on what it shows:

- If steer works, `submit` sends `turn/steer` when a turn is active instead of throwing, `expectedTurnId` set from `this.turnId`, with an adapter test that goes red first.
- If it does not work, that is the finding: record it in `docs/MANUAL_TESTING.md`, leave the rejection in place, and amend D16's line naming this card, since D16 currently reads Codex as a backend that can steer and merely does not.

**Addresses re-verified against `main` on 2026-09-12; line numbers above are as of that day.**

**Corrected 2026-09-09, hours after filing, by the adversarial read of D16.**
This card first said `TURN_ACTIVE_ERROR` is thrown from `submit` at two sites, `:292` and `:375`, and told the implementer to decide about the second.
That was wrong and the instruction was a trap.
`:375` is `compact`'s guard, not a submit path, and the docblock above it at `:358-371` already settles it: `compact` is one of the two `NonSteerableTurnKind`s (`resources/codex-protocol/v2/NonSteerableTurnKind.ts` — `"review" | "compact"`), so app-server will not start a second turn nor steer the live one while one is running, and admitting the request only to have app-server reject it "would turn a well-defined 'busy' into an opaque wire error".
Steering a compaction is protocol-impossible.
**Leave `:375` alone**; D16 is about `submit` and does not reach it.

**Three existing tests assert the rejection message this card may flip**, and none of them is about the rejection.
`codex/adapter.test.ts` — "rejects a submit while a turn is active without erasing its abort target" (`:659`) tests the abort target; "keeps an ambiguous successful submission busy until its response lifecycle completes" (`:1032`) asserts it twice while testing an ambiguous turn response.
Those need rewriting to their actual subjects, not deleting, and a red suite there is the expected consequence of the change rather than a regression.
A fourth site, "refuses to compact while a turn is active, and sends nothing on the wire (OW-72)" (`:695`), shares only the message constant: `compact` keeps its guard either way, so that test stands and must stay green.
