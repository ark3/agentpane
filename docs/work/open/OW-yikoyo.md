---
labels: [question]
---

# Whether an approval kind agentpane knows but cannot answer should decline like an unknown one, or keep hanging the turn until OW-bijera lands

`src/server/adapters/codex/adapter.ts` (`applyEffects`, the `"request"` case OW-nujawi added, and `reply()`), `src/client/App.svelte` (the `selectedSession.requests.length > 0` warning), `docs/DESIGN.md` D2a.

OW-nujawi left the adapter with two different answers to the same situation, and the split is where the gate happened to land rather than a decision anyone took.

A `ServerRequest` whose kind has no `DECLINE_RESPONSES` entry is errored out at arrival: the turn fails in seconds and the error names the kind.
A kind that *does* have an entry -- the approval kinds -- is registered pending and hangs indefinitely, and the warning OW-nujawi wrote tells the user "There is nothing to act on here; end the session to clear it."

Both are unanswerable today, for the same reason: the client half OW-bijera describes does not exist, so no gesture can reach `reply()`.
The difference in outcome is a failed turn versus a dead session needing a manual kill.

## The two positions

**Decline them too, until OW-bijera lands.**
`reply(null)` already sends the right decision shape per kind, so the agent gets a "no" it understands and the turn continues rather than stalling.
A working session where one tool call was refused beats a session the user has to kill, and it makes the adapter's behaviour uniform: agentpane declines what it cannot answer, whatever the kind.

**Keep them pending.**
These are exactly the kinds a future OW-bijera would make answerable, and a decline throws away a decision the user might have wanted to make.
Declining silently also lets the agent proceed on a refusal it may report badly, where a stall at least stops the world in a state a human can inspect.

## Why it is worth deciding now rather than with OW-bijera

Not because it is likely to fire.
The OW-18 run showed `approvalPolicy: "never"` suppressing an `item/fileChange/requestApproval` on a `read-only` thread against a control, so the policy is the guard and arrival needs that policy to stop taking effect -- a `turn/start` that does not inherit it, or a version change.
That is D18's third group, which is the class OW-nujawi was written to defend, and it is the one place the defence is currently uneven.

It is also cheap to decide and expensive to discover: the cost lands on whoever hits it, in a session they have to kill, with the warning telling them that is the only option.

## Done when

The choice is recorded in `docs/DESIGN.md` under D2a, which is where the "an unanswered request hangs the turn" contract already lives, and where a reader meets the question.
D2a currently says the adapter "answers what it can itself" and sends the rest to the browser; whichever way this goes, that sentence needs to say what happens to a kind the browser cannot answer either.

If the answer is decline, the code change is small and belongs with the decision, with a test that a known approval kind arriving is answered rather than left pending -- watched red first, since today it is left pending.
If the answer is keep pending, no code changes and the reasoning goes at the `applyEffects` gate beside OW-nujawi's note, so the asymmetry reads as chosen rather than accidental.

Whichever way it goes, record what it means for `OW-bijera`: a decline makes that card's premise narrower, because the turn no longer hangs and the card is then about offering a choice rather than about unblocking anything.
