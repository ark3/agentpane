---
labels: [question]
blocked-by: [OW-japuzo]
---

# Whether agentpane should stop aborting a streaming Codex turn before forking, now that the parent is known to survive

Filed 2026-09-11 at OW-gojado's close, which that card's own conditional required: "if the parent turn survives and produces something, that is the evidence D15 asked for, and whether to take the asymmetry after all is a question card of its own — file it rather than changing `forkAndSubmit` there."

The evidence exists now and it points at a real choice.

## What the run showed

`docs/MANUAL_TESTING.md`, "Forking a Codex thread mid-stream leaves the parent turn running (OW-gojado)" — home server, 2026-09-11, `codex-cli 0.154.0`, `gpt-5.6-luna`.
A `thread/fork` fired into a parent positively confirmed streaming (a `turn/started` plus five `item/agentMessage/delta`s, no `turn/completed`) succeeded, after which the parent emitted at least 300 further deltas and settled with `turn.status: "completed"` and `turn.error: null`, and its on-disk rollout gained the whole 1491-character reply.
Pi does the opposite: a mid-stream fork there abandons the in-flight turn, which the OW-yudoni run settled on the work laptop.

So the two backends differ as a matter of fact, and agentpane's uniformity is a choice laid over that difference rather than a description of it.

## Why this is a decision and not a defect

`docs/DESIGN.md` D15 was rewritten at OW-gojado's close and now states the finding, keeps the abort, and — this is the part that makes the question live — retires one of the two reasons it used to rest on.
The old second reason was that a surviving turn "streams its reply into a session nobody is looking at, tokens spent to produce an orphan".
The run is that claim's own counterexample: the reply is durable in the parent's rollout, the parent is a session agentpane lists and the user can navigate back to, and the tokens are spent either way because the abort lands after the model has already produced most of the reply.
D15 says so explicitly and now rests on uniformity across backends alone.

Uniformity is a real argument and may well carry the decision — Pi cannot be brought to match, so a backend-dependent answer would be a permanent split, which is OW-hezidi's original "reads as a bug" worry.
This card does not take a side.
It exists because the decision is now being made on one argument where it used to be made on two, and nobody has looked at it in that state.

## What taking the asymmetry would touch

`src/client/controller.ts` `forkAndSubmit` — `if (view.state.sessions[sessionKey(ref)]?.isStreaming) await api.abort(ref);` is the whole of the behaviour, and the comment above it states the reasoning.
`src/client/App.svelte` — `sendLabel` is `$derived(editing ? (streamingAction ? "Stop and fork" : "Fork") : "Send")`, and the edit affordance reads `{streamingAction ? "Stop and edit" : "Edit last message"}`.
D15's closing line is the constraint: the label follows the behaviour, and both read "Stop and ..." only because the stop is real.
A backend-dependent abort means a backend-dependent label, which is a second decision inside this one and is the part most likely to be underestimated.
`src/client/App.test.ts` and `src/client/controller.test.ts` both assert those labels by name; `controller.test.ts` around the "the button says 'Stop and fork'" comment is where the current contract is pinned.

## What the owner said on 2026-09-11

Recorded from the discussion that blocked this card on OW-japuzo, because these are the owner's own weightings and nobody should re-derive them from first principles.

**The owner forks mid-stream regularly.**
Asked directly whether the workflow ever involves scrolling back and editing while a turn is running, the answer was that it absolutely does.
So this is not a decision about a window nobody enters, which is what an earlier reading of the race suggested.

**The stated preference is to let the existing turn finish.**
"I'm inclined to let the existing turn finish; it's frustrating that Pi doesn't allow that."
That is a lean, not the decision -- the decision is still what this card is for, and it now waits on what OW-japuzo measures about Claude Code.

**Why it has never bitten in practice, despite that.**
The abort fires only if `isStreaming` is still true at the moment of submit, so composing a revision usually outlasts the turn's remainder and the check falls through.
The owner's own words: "perhaps I don't type that fast."
Everything in the action row is `$derived`, so when the turn settles the submit button changes "Stop and fork" to "Fork", the shortcut changes "Stop and edit" to "Edit last message", and the red Stop button disappears -- all with no motion from the user, mid-compose.

## Mechanics established in that discussion

These were traced in the session and are worth not re-tracing.

**There is exactly one fork path.**
`api.fork` has a single call site in the client, at `forkAndSubmit` in `src/client/controller.ts`.
No standalone fork affordance exists, so "the abort" and "forking" cover the same set, and this decision is not a special case carved out of a larger feature.

**The abort does not affect what the fork contains.**
Codex forks at `lastTurnId`, computed in `codex/adapter.ts` `fork()` as the turn before the fork point, so the in-flight turn is excluded either way.
Nothing about the child changes with the abort; only the parent's turn does.

**The turn being stopped is the parent's own.**
The check reads `view.state.sessions[sessionKey(ref)]?.isStreaming` where `ref` is the session being forked -- not some other session streaming elsewhere.

**`editLastMessage` is not this decision.**
The composer's "Stop and edit" shortcut aborts at the click, `src/client/App.svelte`, and its docblock names itself the one exception to OW-hezidi's free-and-abandonable rule.
On that path the stop was the user's decision, announced in the button.
Where this card bites is the transcript path: clicking an earlier message while a turn streams announces no stop, and the only warning is `sendLabel` having changed.
Note also that the abort there is not awaited and `controller.abort` never clears `isStreaming`, so `forkAndSubmit`'s check can still fire a second abort; that is deliberate and the docblock says so.

**Compaction closes the window entirely.**
`streamingAction` is gated on `compaction === null`, and the submit button carries `disabled={!view.draft || compaction !== null}`, so no fork is possible during a compaction on Codex or Claude regardless of what the wire says about streaming.

## Scope widened

This card was filed on the Codex evidence and its headline says so, but the decision it records lives in D15, which governs the abort on every backend.
Claude Code has never been weighed there at all -- see OW-japuzo.
Whoever takes the decision takes it for all three, or states explicitly why Codex alone.

## Done when

The decision is recorded in `docs/DESIGN.md` D15 — either as a restatement that the abort stays on uniformity alone, now that it has been re-examined against OW-gojado's evidence, or as a change of decision with the behaviour and labels that follow it.
Either way D15 stops being a decision whose second reason was removed without the first being re-weighed.

If the decision is to keep the abort, that closes this card and nothing else changes.
If the decision is to take the asymmetry, the behaviour change and the label change are work, and belong in their own cards filed from this one — do not fold them in here.

Blocked on OW-japuzo: the Claude Code measurement is the evidence this decision is now missing.
Beyond that it needs no live run of its own -- the Pi and Codex evidence is already recorded.
