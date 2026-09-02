---
labels: [change, browser-testing]
---

# Reading view hides the streaming tail, so a running session shows a still page: nothing on screen says the agent is mid-tool-call rather than stopped.

`src/client/render/transcript.ts` (`condense`), `src/client/render/Transcript.svelte`, `src/client/App.svelte` (`reading`, `scheduleFollow`, `reconcile`), `e2e/follow.spec.ts`, `src/client/render/transcript.test.ts`.

Reading view (OW-51) elides tool calls, tool results and thinking so the prose can be read while a session runs.
Its close note records the decision that came with it: "No liveness cue is needed: the Abort button renders only while streaming and the sidebar row carries a ●."
The owner has now spent real time in the mode and overturns that on 2026-09-02: both of those cues are outside the transcript column you are reading, and while the agent works through tool calls the column itself is motionless with no indication of what it is doing.

Give reading view one compact line at the tail, while the turn is streaming, saying what the agent is doing right now -- the last elided tool call or thinking block.

## Shape

**A one-line status, not the real card.**
Decided with the owner: rendering the actual tool card at the tail would put back most of what reading view turns off, and the result folds in under it.
The line is the kind of thing a status bar says -- the tool and its subject, or that the agent is thinking -- and it reads as chrome, not as a message in the transcript.
How that line is composed is open, but there is already a renderer that names a tool call for a human in `src/client/render/tools/`; reach for it before inventing a second vocabulary, and note in the card's commit which way it went.

**Streaming only.**
It appears while the turn runs and is gone once the turn ends; a finished session in reading view looks exactly as it does today.
A preview is a static snapshot and never streams, so this is confined to the attached pane by construction rather than by a check on `preview`.

**Only when there is something elided to report.**
A streaming turn whose tail is ordinary assistant text is already visible, and the line has nothing to add.

## The interaction that will bite

The line appears and disappears while follow mode is armed, which changes the transcript's height mid-turn.
That is the exact shape of the defect OW-56 found in a real browser: a shrink-induced bottom clamp in Chromium emitted a scroll event that cleared follow, and `App.svelte` now retains follow only when an event correlates with a recorded `scrollHeight` decrease.
jsdom cannot see any of this, so this card is not settled by unit tests alone.

`condense` is pure and index-preserving on purpose: `TranscriptEntry.index` is a position in the original `messages` array and follow mode finds its anchor by that number.
Whatever carries the new line must not renumber anything -- which is a reason to render it outside the entry list rather than as a synthetic entry.

`condense` today takes only a built view and knows nothing about streaming; the tail's liveness comes from `isStreaming` in `Transcript.svelte`.
Deciding where the "what is it doing" fact is computed is part of the work, and the pure-and-testable side of that seam is worth keeping wide.

## Related, not folded in

OW-pezero is the separate open defect that reading view calls a tool-only transcript empty.
This card makes the streaming half of that case less visible; it does not close it, and the two should not be merged.

## Two copies of the overturned decision live in `src/`

`condense`'s docblock in `transcript.ts` says "reading view carries no liveness cue by design", and `transcript.test.ts` repeats it in a comment beside the dropped streaming placeholder.
Both are false once this lands, and a correction filed only in this card reaches nobody reading the code.
Retire them in the same change.

## Done when

- A unit test in `transcript.test.ts` or a jsdom test in `App.test.ts` asserts the line names the last elided tool call for a streaming turn, and a sibling asserts nothing is drawn once the same turn is not streaming.
- A test asserts the entry indices are unchanged with the line present, so the follow anchor still resolves.
- A browser test in `e2e/follow.spec.ts` (or a focused sibling) attaches, seeds enough turns to scroll, submits a paced turn in reading view, and asserts that the line's appearance and its disappearance at turn end both leave follow engaged, within the existing `LOCKED_PX` tolerance.
- Each watched red first, the browser one by sabotaging the follow path it exercises rather than by assertion alone.
- `bun run check` and `bun run test:browser` both green.

Load-bearing: streaming-only, index preservation, and that follow survives both height changes.
Incidental: the line's wording, its placement within the pane, and where the fact is computed.
