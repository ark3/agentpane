---
labels: [question]
blocked-by: [OW-razoki]
closed: done
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

## Reframed 2026-09-13: this decision now falls out of the architecture

The owner reframed the question rather than answering it as posed, and that reframing is the useful part.

The question this card asks -- whether to keep the abort -- was framed as a choice between uniformity and letting the parent turn finish.
That framing assumed a fork on Claude has to kill the parent.
It does not.
`OW-razoki` carries the finding: Codex's `fork()` leaves the parent's adapter alone and returns a ref the client attaches as its own container, where Claude's calls `replaceProcess` and kills the child.
The owner's model, stated in discussion, is Codex's: "the current session to remain as-is and a new session to be started, with a new session container, so both the original and the fork end up as full-fledged sessions."

So the abort is not a decision to take on its own.
Once Claude forks the way Codex does, the abort is left standing only where the backend forces it, which is Pi.
That is the answer, and it is a consequence rather than a choice: nobody has to weigh uniformity against a surviving reply, because the only backend that loses the turn is the one whose CLI abandons it regardless.

**What this card becomes.**
Record that in D15, after `OW-razoki` lands.
The behaviour and the labels that follow from it are `OW-bakosi`, filed 2026-09-13 as this card's terms below require; they are not this card's work.
D15's uniformity argument does not survive it and should not be restated -- the split it feared is now one backend behaving differently because it genuinely behaves differently, which is what the labels exist to say.

**The Claude evidence that moved it**, from OW-japuzo's close note: nothing reaches Claude's store file until after the wire says the turn is over -- four marks across one reply, byte-identical each time, the last at about 78% of a 1491-character answer -- so the abort there destroys the entire reply, where D15 can say of Codex that the reply landed anyway.
The uniformity argument was protecting the case where the loss was largest and had never been weighed.

**Do not take this decision before `OW-razoki`.**
If that card finds Claude's fork cannot mint its own container cheaply, the abort question comes back as a real choice and this card is where it gets taken.

## Done when

The decision is recorded in `docs/DESIGN.md` D15 — either as a restatement that the abort stays on uniformity alone, now that it has been re-examined against OW-gojado's evidence, or as a change of decision with the behaviour and labels that follow it.
Either way D15 stops being a decision whose second reason was removed without the first being re-weighed.

If the decision is to keep the abort, that closes this card and nothing else changes.
If the decision is to take the asymmetry, the behaviour change and the label change are work, and belong in their own cards filed from this one — do not fold them in here.

Blocked on OW-razoki, which is what makes the answer fall out rather than needing to be chosen.
OW-japuzo supplied the Claude measurement this card was previously waiting on; no further live run is needed here.

## Close note

The decision is recorded in `docs/DESIGN.md` D15, rewritten in aafde65.
It is a change of decision, not a restatement: the abort is Pi-only.

## The decision as recorded

D15 is now headed "agentpane stops a streaming turn before forking it only where the backend abandons that turn anyway, which is Pi".
The reasoning is this card's own reframing, and it is stated as a consequence rather than a choice: the old framing assumed a fork on Claude had to kill the parent, and it did not -- the kill was agentpane's `replaceProcess`, which OW-razoki deleted on 2026-09-13.
With Codex and Claude both leaving the parent turn alone, the only backend that loses the turn is the one whose CLI abandons it regardless, so nobody weighs uniformity against a surviving reply.

D15 carries one block per backend, each naming the version its behaviour was measured on: Pi on the work laptop 2026-08-20 `pi 0.84.2` (OW-yudoni), Codex on the home server 2026-09-11 `codex-cli 0.154.0` (OW-gojado), Claude on the home server 2026-09-11 `claude 2.1.268` for the probe (OW-japuzo) and 2026-09-13 `claude 2.1.270` for the live run through `bun run start` (OW-razoki).
It says the uniformity argument does not survive and should not be restated, and it says why uniformity was doing its heaviest work on the backend whose cost had never been weighed: on Claude nothing reaches the store while the turn runs, so the abort destroys a whole reply that would otherwise have landed.

D15 also states plainly that the behaviour has not changed yet.
`forkAndSubmit` still aborts on every backend and the comment above that line still argues uniformity; that comment and the labels are OW-bakosi's, which this card filed and deliberately did not fold in.

## The conditional

Discharged before the close, and it fired the way this card expected.
The decision was to take the asymmetry, so the behaviour and label change belong in their own card: OW-bakosi, filed 2026-09-13 from this card and now unblocked by OW-razoki.

## The copies this change owed

Retiring the uniformity argument meant retiring every live copy of it, not just D15's own.
Three sites, all in the same commit:

- `docs/DESIGN.md` D18's bullet list cited "D15's uniformity" as a fact behind a decision already taken; it now cites D15's per-backend fork behaviour.
- `resources/probes/README.md` and `resources/probes/claude_fork_probe.py` both quoted D15's old heading as current -- "D15 is headed 'on every backend' ... Claude Code is not mentioned in it once" -- and both described `replaceProcess`'s kill in the present tense ("the kill `fork()` performs today", "Cell 1: the kill the adapter performs today").
  That second one was already false before this card: OW-razoki deleted `replaceProcess` and the correction landed in `docs/MANUAL_TESTING.md` and not in the docblock a reader meets at the code, which is `AGENTS.md`'s 034d7dd failure repeated.
  Both files now date the claim to what it was at the run and name OW-razoki.

Hits left alone on purpose: `docs/MANUAL_TESTING.md`'s several references to D15's old heading are inside dated run sections and are historical records, and the `forkAndSubmit` comment is OW-bakosi's by that card's own done-condition.

## What review caught

The dispatching session wrote D15 itself, so an adversarial reader was dispatched at the finished text and its report checked against the sources rather than taken on trust.
It found the four stale probe/README copies above, which is the finding worth keeping.
It also caught two overstatements and a misquote in the new text, all fixed before the commit:

- "six `item/agentMessage/delta`s accumulated against a threshold of five" was wrong and had been carried forward verbatim from the old D15.
  `docs/MANUAL_TESTING.md` records five, and `fork_probe.py` passes `min_deltas=5`.
- "the price of the abort there ... is the highest of the three" is unmeasured against Codex -- nobody measured how much of a Codex parent's partial reply is on disk at an abort.
  D15 now says the abort's cost on Claude is larger than on Codex and states explicitly that this compares what the abort destroys, not bytes.
- The quoted retired reason had "its reply" interpolated inside the quotation marks; it is now verbatim from the pre-change text.
- "which is what the labels exist to say" was present tense about labels that do not vary by backend yet; it now reads "will be there to say".

## Verification

Docs and one probe file; no `src/` change, so `bun run check` does not apply and was not run.
`python3 -m py_compile resources/probes/claude_fork_probe.py` passes.
