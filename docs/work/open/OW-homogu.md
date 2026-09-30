---
labels: [defect, emacs]
---

# At a seq gap agentpane-mode forgets the turn-done watch, so a re-attach under the same live handle never raises the indicator for the turn the gap interrupted, where the browser's watch survives the gap

Filed 2026-09-30 from the adversarial read of OW-kutome, which found that its fix is a check at the site the symptom showed and named two cases that check misses.

## What OW-kutome built

`session/detached` carries `cause: "ended" | "gapped"` (`src/emacs/protocol.ts`, the thirteenth raise of the frozen interface), filled by `end` and `detachGapped` in `src/emacs/helper.ts`.
`agentpane--let-go` in `emacs/agentpane.el` takes `&optional gapped` and, when set, calls `agentpane--watch-forget` before `agentpane--read-idle`, so the gap raises nothing.
The underlying mechanism is unchanged: `agentpane--read-idle` fabricates a not-streaming status and folds it into the turn-done watch (`agentpane--set-status` into `agentpane--watch-turn`) as though the server had sent it, and each cause now decides whether the watch is dropped before that fold.
The browser does no such fold: `detachGapped` in `src/client/controller.ts` deletes the view, and `watchSessions` in `src/client/favicon.ts` skips a key with no view with `continue`, so the watch survives the gap.

## Case A: a re-attach under the same handle

A gap leaves the handle live, so the buffer's next attach (a send or `agentpane-attach`) answers under the same handle.
Emacs has already dropped the watch, so if the gapped turn is still running, its end raises nothing.
In the browser a later snapshot under the handle, from this client's re-attach or even another client's attach (the snapshot arm of `src/client/session-state.ts` forms a view for any snapshot), re-forms the view, and the surviving watch raises the favicon at the turn's end.
The reader showed both with probes on 2026-09-30.
In Emacs the sequence was submit, streaming status, gapped detach, `agentpane-attach` answering `h1`, streaming status, not-streaming status; it printed `after re-attach: handle="h1" watches=nil` and then `raised=nil`.
In the browser, driving `watchSubmit h1` and then the view maps `{h1:true}`, `{}` and `{h1:false}` raised the badge.

## Case B: a gap revealed by the turn's own end

The event whose `seq` exposes the gap can be the turn's final `status` with `isStreaming: false`, since the reducer applies nothing from a gapped event (`reduceServerEvent` in `src/client/session-state.ts`).
Before OW-kutome, Emacs raised the indicator there; now it raises nothing unless the buffer is re-attached.
With the watch kept, as in case A, a re-attach's snapshot would raise it, as the browser's does.

## What is load-bearing

The browser is the parity reference (AGENTS.md, "Both clients").
Emacs deliberately raises at the server's `ended` and at a helper's death, where the browser, whose view goes at `ended` too, raises nothing (OW-zedawo, D25 point 4).
That is Emacs-only and out of this card's scope, but the replacement must keep it: `agentpane-test-turn-done-raised-when-the-server-lets-go` and `agentpane-test-turn-done-watch-ends-with-the-helper` in `emacs/agentpane-test.el` stay green.
Whether a deliberate `agentpane-shutdown` should raise is OW-reyayi's question, and this card does not decide it.
Keeping a `sent` watch across a gap reopens the OW-dunahe hazard, where a turn from elsewhere raises the indicator under a handle a re-attach answered, so the replacement probably keeps only a `streamed` watch.
The claim in the `agentpane--watch-turn` docstring that "a watch on a handle the server has let go of is never read again" holds for `ended`; a gapped handle is exactly the one that may be read again.

## Done when

The gap no longer drops the watch by an ordering flag in `agentpane--let-go`: the `gapped` branch that calls `agentpane--watch-forget` ahead of `agentpane--read-idle` is gone, and at a gap nothing is folded into the watch.
An ERT test in `emacs/agentpane-test.el`, red first, drives case A: submit from a buffer no window shows, see it stream, deliver a `session/detached` with `:cause "gapped"`, re-attach under the same handle, see it stream and then stop; the indicator is raised.
`agentpane-test-turn-done-not-raised-by-a-gap` still passes: nothing is raised at the gap itself.
The docstrings of `agentpane--let-go` and `agentpane--watch-turn` say what the gap does to the watch.
`bun run check` and the ERT suite pass.
