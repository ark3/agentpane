---
labels: [defect, now]
---

# Steering a Codex turn desynchronizes the fork-point ordinal, and Edit forks at the wrong message

Landed by OW-tifuha: now that the Codex adapter steers a mid-turn `submit()`, a steered turn holds two `userMessage` items, and Codex's fork points are per *turn*.
The transcript and the fork-point list stop counting the same things, silently.

**The invariant that breaks.**
`src/client/controller.ts` states it in the docblock over `fork` — "The ordinal indexes `GET fork-points`, which answers one point per user message in transcript order on every backend -- the caller counts user messages and never matches on wording" — and `src/client/App.svelte`'s `startEdit` implements exactly that count: it walks the transcript and increments `ordinal` for each `role === "user"` message before the clicked index.
`controller.ts`'s `fork` then does `const point = points[ordinal]`.

**Why Codex no longer satisfies it.**
`src/server/adapters/codex/adapter.ts`'s `listForkPoints` pushes one `ForkPoint` per turn, labelled by `firstUserText(turn.items)`, and `firstUserText` returns at the *first* `userMessage` in the turn.
Its docblock says why — "Codex forks at *turn* granularity (`ThreadForkParams.lastTurnId`), not at item granularity".
That yielded one point per user message only because every Codex turn used to hold exactly one.
The live probe recorded in `docs/MANUAL_TESTING.md` under "Observed Codex `turn/steer` against a live turn (OW-tifuha)" shows the steered `userMessage` arriving inside the running turn, and `src/server/adapters/codex/mapping.ts` maps it to a `role: "user"` message in the flat transcript.

Pi is unaffected: `src/server/adapters/pi/process.ts` maps `get_fork_messages` one point per message, which is why the invariant survived Pi already steering mid-turn.

**What the user sees.**
Turns T1 and T2, with T1 steered once: three user messages in the transcript, two fork points.
Click Edit on T2's user message and `ordinal` is 2, so `points[2]` is `undefined` and the fork fails with "That message is no longer a fork point in this session."
Add a T3 and the same click resolves `points[2]` to T3 — the fork keeps one turn *more* than the user pointed at, the edited prompt lands on the wrong branch, and there is no error and no signal.
Forking *at* a steered message is unreachable either way, because no fork point names it.

**Load-bearing vs incidental.**
Load-bearing: that Codex's fork granularity is the turn, which is a protocol limit and not a choice — `thread/rollback` is DEPRECATED in the generated bindings, as `listForkPoints`'s docblock records.
So the fix is not "make Codex emit a point per user message"; a point that cannot be forked at is worse than none.
The real decision is what the ordinal contract becomes when a backend cannot fork at every user message: a fork point that names its transcript index, an Edit button disabled on messages no point can reach, or something else.
Incidental: the specific turn counts in the scenario above.

## Decided 2026-09-13

The owner took the contract question this card left open.
It is no longer "what does the ordinal contract become"; it is this, and the implementer builds it rather than re-deciding it.

**A fork point names its position in the transcript, and the client stops counting.**
`ForkPoint` in `src/shared/protocol.ts` is `{ id, text }` today, with no index, which is why the correspondence between it and `startEdit`'s count was only ever positional and implicit.
Give it the transcript index, have `startEdit` look up the point *at* the clicked message instead of counting user messages before it, and the disagreement becomes detectable at the point of use rather than silent.

**Edit is unavailable on a message no fork point can reach.**
This is the consequence of the above rather than a second decision: once a point names its index, a message with no point is knowable before the click.
The owner's words: "We don't need to fork from a steering note."
So the steered message in a turn is simply not a fork target, and the affordance says so instead of failing or -- worse -- silently forking one turn further on.

**What this rules out, and why.**

*Folding a steered message into the turn's first user message* so Codex again holds one user message per turn.
Rejected: the transcript would show one message where the user sent two, which hides the steer that OW-tifuha shipped.

*Backing out Codex steering.*
Rejected: D16 says a backend that can steer should, and OW-tifuha measured that Codex can.

*Emitting one fork point per user message on Codex.*
Rejected on the ground this card already states -- Codex forks at turn granularity, `thread/rollback` is deprecated, and a fork point that cannot be forked at is worse than none.

**A UI consequence the owner accepted explicitly.**
Edit is available on the first user message of a steered turn and unavailable on the steered one, within the same turn.
That is visibly uneven, and it is the intended outcome: it tells the truth about what the backend can fork at, where the alternatives paper over it.

**The cost to report rather than assume.**
Whether the Codex adapter can cheaply know a turn's position in the flat transcript.
`listForkPoints` walks `read.thread.turns`, the transcript comes from the reducer, and nothing bridges the two today.
If that bridge turns out to be expensive, say so in the close note rather than reaching for one of the rejected options.

## Done when

A test in `src/client/` goes red first on the desynchronized case — a Codex transcript whose turn holds two user messages, an Edit on a later message, asserting the fork lands on the turn the user pointed at or is refused outright — and green after.
The contract that resolves it is recorded where the next reader meets it: the `fork` docblock in `src/client/controller.ts`, whose present wording ("one point per user message in transcript order on every backend") is what this card falsifies, and in `docs/DESIGN.md` if it changes a decision.
