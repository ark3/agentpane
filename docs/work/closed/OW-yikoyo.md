---
labels: [question]
closed: done
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

## Close note

Decided 2026-09-11: a request the browser cannot answer is declined rather than held, recorded in `docs/DESIGN.md` D2a under "And when the browser cannot answer either". Where the kind has a `DECLINE_RESPONSES` shape it gets that shape, so the model reads a "no" it can carry on from and try something else; where it does not, the JSON-RPC error OW-nujawi already sends stands. The user is told what arrived in both cases.

The reasoning that carried it: a turn continuing from a refusal beats a session the user has to destroy, and the warning OW-nujawi wrote was itself the argument -- it told the user that killing the session was the remedy. The counter-argument, that these are exactly the kinds OW-bijera would make answerable, did not hold, because bijera is not merely unbuilt but currently unstageable: nothing can produce a live request to test it against. The decision is provisional and bijera revisits it.

The implementation is **not** in this card and was deliberately not folded in. Two attempts at it during this session both failed, and the second failure is the useful one:

- Declining without publishing takes eight tests in `adapter.test.ts` red -- request namespace per adapter lifetime, typed reverse mapping for pre-adoption requests, wire-id scoping, numeric-versus-string wire ids, reply correlation, and both OW-futewo cases. They become meaningless rather than adaptable, and OW-bijera needs that machinery back.
- Declining *and* publishing is worse: `reduceServerEvent`'s `request` arm appends to `view.requests` and nothing removes from it, so the warning would stand permanently over a turn that had already continued. Today's warning is true; that version is a lie that never clears.

Both fail on the same missing thing: `ServerEvent` can announce a request and cannot retract one. `OW-gusifo` carries the implementation with that wire event as its first move, and D2a's closing paragraph now names the gap and points at it. It is sequenced before OW-bijera, not after, because bijera needs the same retraction for its own removal path.

No code changed under this card. The working tree was taken to the first implementation and reverted once its cost was measured.
