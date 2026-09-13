---
labels: [defect, now]
closed: done
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

## Close note

Built, landed on `main` as 2d922f0 (server + protocol), 9724ed7 (client) and 4c6c257 (D20 in `docs/DESIGN.md`).
`bun run check` green (1036 tests) and `bun run test:browser` green (20 passed), both re-run in the main checkout after the cherry-pick.

**What it is now.**
`ForkPoint` in `src/shared/protocol.ts` carries `index`: the position, in the array `snapshot.messages` and `upsert.index` address, of the user message it forks at.
`forkAndSubmit` resolves a point with `points.find(p => p.index === index)` and refuses when nothing matches; `startEdit` no longer counts user messages, and `Transcript.svelte` draws an Edit control only on indices some point names.
The counting invariant is gone rather than repaired -- D20 records that, and the three docblocks that stated it (`forkAndSubmit` in `src/client/controller.ts`, `editing` in `src/client/App.svelte`, `forkPoints` in `src/client/api.ts`) were rewritten.

**The Codex index cost the card asked to be reported, not assumed: it is cheap, and no bridge had to be built.**
`CodexReducer.slots` was already a `Map<itemId, Slot>` populated identically on the hydrate and live paths, and `startIndex(slot)` already existed as a private.
`indexOfItem(itemId)` is six lines wrapping the two.
The adapter never needs a turn's position in the transcript -- it needs the turn's first `userMessage` item's id, which `thread/read` already carries, so `firstUserText` became `firstUserItem` and returns id alongside text.
A slot miss drops the point, costing an Edit affordance and never mis-placing one.
An index computed from a position within `turn.items` would have been wrong and is explicitly warned against at `indexOfItem`: `mapping.ts` answers zero messages for a hidden `reasoning` item, for every `SILENT_ITEM_TYPES` member and for any item type a newer `codex-cli` adds, and two for a tool call with a result.

**Pi** pairs `get_fork_messages` against `this.state.messages`'s user indices server-side -- the client's old count moved to the one place both arrays are in hand, which is what makes a disagreement detectable.
On a length mismatch it answers with **no points at all**: nothing can say where two unequal lists diverged, and pairing the common prefix would be the same silent mis-fork this card exists to remove.
Losing every Edit control is visible and recoverable; forking a turn away is not.

**Claude** derives each index by replaying the store entries through a throwaway `ClaudeReducer` -- the same walk cold-start hydration does -- so the answer is the reducer's by construction, and each point is re-checked against the live reducer before it ships.
This fixed a **pre-existing off-by-one** that had nothing to do with Codex: `claudePromptText` filtered only `isSyntheticBlock` while the reducer's `handleUser` also drops `isSynthetic`, `isCompactSummary` and `isReplay` lines, so a compacted session emitted a fork point with no user message behind it and every ordinal after the compaction addressed the wrong message.
`claudePromptText` had no other caller and was removed.
On staleness: as of `claude 2.1.268` the store gains no content until a turn ends (MANUAL_TESTING OW-japuzo), so the store is a *prefix* of the live array, and a prefix's indices are the live array's indices -- a lagging store loses points at the tail, never mis-places one.

**Client-side choice.**
`ControllerView.forkIndices: number[] | null`, not a `SessionView` field -- only the selected session draws Edit controls, and a `SessionView` write is how `replaceSessionSummaries` distinguishes a touched session from an untouched one (an early version on `SessionView` broke "forgets a cached live session when a fresh listing reports it detached").
Refreshed at attach, at both directions of a turn boundary, and on any snapshot; the e2e harness proved the snapshot trigger necessary.
`null` means not-yet-answered and offers every user message a control, because the worst that window can produce is a refusal.
"Edit last message" takes the same gate and goes absent rather than searching backwards.

**Red-then-green, reproduced independently by the dispatching session, not taken on the implementer's word.**
Reverting `forkAndSubmit` to `points[index]` turns three `src/client/controller.test.ts` tests red, including "refuses, rather than forking elsewhere, at a message steering added mid-turn (OW-roveze)" -- which stocks three fork points precisely so a positional lookup finds *something* at every position a click can produce, reproducing the silent half of the defect.
Also red first: two `App.test.ts` affordance tests, two new `codex/adapter.test.ts` tests (which needed a `thread/read` case added to `configureHappyServer` -- there had been zero adapter-level coverage of Codex `listForkPoints`), and a `claude/adapter.test.ts` test that reproduces the compaction off-by-one.

No live-run evidence was produced, so `docs/MANUAL_TESTING.md` is untouched; the code cites OW-japuzo (`claude 2.1.268`) and OW-tifuha/OW-gojado (`codex-cli 0.154.0`) by their recorded versions rather than adding any.

**Filed from this execution:** OW-sibebe (`e2e/perf-harness.ts` answers no fork points, so its transcripts now render with no Edit controls -- a fidelity gap this change introduced) and OW-lizohe (a fork-points refresh in flight is dropped across Pi's rename, so Edit controls are stale for a turn right after a fork).
