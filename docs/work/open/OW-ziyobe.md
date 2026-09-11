---
labels: [question]
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

## Done when

The decision is recorded in `docs/DESIGN.md` D15 — either as a restatement that the abort stays on uniformity alone, now that it has been re-examined against OW-gojado's evidence, or as a change of decision with the behaviour and labels that follow it.
Either way D15 stops being a decision whose second reason was removed without the first being re-weighed.

If the decision is to keep the abort, that closes this card and nothing else changes.
If the decision is to take the asymmetry, the behaviour change and the label change are work, and belong in their own cards filed from this one — do not fold them in here.

Needs no live run: the evidence this turns on is already recorded.
