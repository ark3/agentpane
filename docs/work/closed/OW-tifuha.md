---
labels: [change]
closed: done
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

## Close note

`turn/steer` works. Run live on the home server 2026-09-12 against `codex-cli 0.154.0`: fired 29 deltas into a streaming turn with `expectedTurnId` naming that turn, it returned `{"result": {"turnId": "<same id>"}}`, and the steered `userMessage`, a `reasoning` item and the answering `agentMessage` all arrived under that turn id — exactly one `turn/completed`, no second turn opened. The probe extension that shows it is in `resources/probes/codex_turn_probe.py`; the full observation, including what the run did *not* show (the first `agentMessage` had already completed, so no steer was seen cutting an in-flight message short), is `docs/MANUAL_TESTING.md`, "Observed Codex `turn/steer` against a live turn (OW-tifuha)".

So the first branch of the card fired. `src/server/adapters/codex/adapter.ts`'s `submit()` sends `turn/steer` with `expectedTurnId: this.turnId` when it holds a turn id, instead of throwing `TURN_ACTIVE_ERROR`; it still throws when `turnBusy` is set under an id it cannot name, because `expectedTurnId` is a precondition with nothing to put in it. `compact()`'s guard is untouched. D16 in `docs/DESIGN.md` now reads Codex as a backend that steers.

Tests: "steers a submit into the active turn instead of starting a second one (OW-tifuha)" is new, and "rejects a submit while a turn is active without erasing its abort target" is rewritten to its actual subject as "keeps its abort target across a mid-turn steer". Both were shown red against the pre-change adapter at the dispatching session's own hand, then green. The ambiguous-response test is renamed to "cannot steer an ambiguous submission, and stays blocked until its response lifecycle completes" and now also asserts no `turn/steer` on the wire. The OW-72 compact test stands unchanged and green. `bun run check` green, 1027 tests.

The adversarial read of the finished work found three things, and they are the reason this card is worth reading again:

- **A compaction turn is steerable-looking and is not.** `resources/fixtures/codex/compact.jsonl` shows a compaction runs as its own turn, so `turn/started` leaves the adapter holding a `turnId` naming it — and `compact` is one of the two `NonSteerableTurnKind`s. `submit()`'s new branch tested only `if (this.turnId)`, so it would have steered a compaction and turned a well-defined "busy" into app-server's opaque wire error, verbatim the outcome `compact()`'s own docblock says its guard exists to prevent. Reachable past the client's disabled Send by a threshold compaction, a second client, or `POST prompt`. Fixed here in `da5b86b` with the test "refuses to steer a compaction turn, and sends nothing on the wire (OW-tifuha)", shown red first.
- **Steering desynchronizes Codex's fork points** — a steered turn holds two user messages where `listForkPoints` answers one point per turn, so the ordinal `controller.ts` computes by counting user messages stops indexing that list, and a later Edit silently forks at the wrong turn. Filed as **OW-roveze**, labelled `now`, and named in D16. Not fixable inside this card: Codex's fork granularity is the turn (`ThreadForkParams.lastTurnId`, with `thread/rollback` deprecated), so what the ordinal contract becomes on a backend that cannot fork at every user message is an open decision.
- **A `submit()` between `abort()` and `turn/completed`** steers a turn being torn down, because `abort()` never clears `turnId`. A legibility regression only — the user got an error before too, just a legible one. Filed as **OW-pefawi**.

D16's existing note that this change makes OW-nasofa's in-flight guard load-bearing on Codex is now live fact rather than prediction: a second Ctrl-Enter during the round trip steers a duplicate into the running turn.
