---
labels: [change]
blocked-by: [OW-razoki]
---

# The fork abort and the stop-first labels become Pi-only, once Codex and Claude both leave the parent turn running

Filed 2026-09-13 from `OW-ziyobe`, whose own terms require it: "If the decision is to take the asymmetry, the behaviour change and the label change are work, and belong in their own cards filed from this one -- do not fold them in here."
Both are here rather than in two cards because they are one change in one module: the label is derived from the same fact the behaviour keys off, and landing either alone ships a control whose name is false.

## What changes

`src/client/controller.ts` `forkAndSubmit` holds the whole behaviour in one line -- `if (view.state.sessions[sessionKey(ref)]?.isStreaming) await api.abort(ref);` -- with a comment above it stating the reasoning that this card retires.
That abort becomes conditional on the backend, and survives only on Pi.

`src/client/App.svelte`:

- `sendLabel`, currently `editing ? (streamingAction ? "Stop and fork" : "Fork") : "Send"`, reads "Stop and fork" only on Pi.
  On Codex and Claude an edit submitted mid-stream is just "Fork".
- The composer shortcut's text, `streamingAction ? "Stop and edit" : "Edit last message"`, follows the same rule.
- `editLastMessage`'s own `if (streamingAction) void controller.abort();` is the click-time stop behind "Stop and edit", so it goes with the label.

`SessionRef.backend` is already on the ref the client holds, so nothing new is plumbed.

## Why the abort stays on Pi

Not uniformity, and not a preference.
Pi's CLI abandons the in-flight turn on a fork whatever the client does -- the active `sessionFile` moves, `isStreaming` goes false, and `agent_settled` arrives with no assistant text (`docs/MANUAL_TESTING.md`, OW-yudoni, work laptop 2026-08-20, `pi 0.84.2`).
The abort there does not cause the loss; it makes it deliberate and visible, and the label is the only warning the user gets.
That is why this card leaves Pi exactly as it is rather than treating it as the odd one out to be smoothed over.

## Why it goes on Codex and Claude

Codex's parent turn survives a mid-stream `thread/fork` and completes with its whole reply durable on disk -- measured, home server 2026-09-11, `codex-cli 0.154.0` (`docs/MANUAL_TESTING.md`, OW-gojado).
Claude's survives too once `OW-razoki` stops `replaceProcess` killing the child, and the abort costs more there than on Codex: nothing reaches the store file until after the wire says the turn is over, so aborting destroys the entire reply rather than racing it (`docs/MANUAL_TESTING.md`, OW-japuzo, `claude 2.1.268`).

## Do not start before OW-razoki

On Claude this card is a lie until that one lands.
Dropping the abort while `fork()` still calls `replaceProcess` means the turn dies anyway, silently, under a button that no longer warns -- strictly worse than today, where the warning is at least true.
That is the same failure mode `OW-yikoyo` hit and recorded: a control whose label outruns its behaviour.

## Done when

`src/client/controller.test.ts` and `src/client/App.test.ts` both pin the split, each going red first.
Those suites assert the current labels by name -- `controller.test.ts` around the "the button says 'Stop and fork'" comment is where the contract is pinned today -- so the existing cases are rewritten per backend rather than deleted, and any that cannot be are named in the close note.

A streaming Pi session in edit mode still aborts before forking and still says "Stop and fork".
A streaming Codex or Claude session in edit mode forks without aborting and says "Fork", and the parent turn is still streaming afterwards.

The comment above the abort in `forkAndSubmit` is rewritten, not deleted: it currently argues for uniformity across backends, which is the position this card ends, and the next reader needs to know the asymmetry is deliberate rather than an oversight.

`bun run check` passes.
The action row is one of the places `AGENTS.md` names for a hand-run of `bun run test:browser` before committing, so run it and say so in the close note; this changes button text and a conditional control, not layout, so it is expected to be uneventful.
