---
labels: [defect, emacs]
---

# A sequence gap mid-turn raises agentpane-mode's turn-done indicator though the turn goes on, where the browser's favicon raises nothing

Filed 2026-09-28 from the adversarial read of OW-filuge, which gave `session/detached` a second cause: a session whose `seq` gapped (`detachGapped` in `src/emacs/helper.ts`, D25 point 5 in `docs/DESIGN.md`).
The reader confirmed it with an ert probe: after a turn submitted from Emacs was seen streaming in a buffer no window showed, `agentpane-test--turn-done-p` in `emacs/agentpane-test.el` read `t` right after the gap's `session/detached`.

## Why it is wrong

Until OW-filuge a `session/detached` meant the server had let go of the handle, so the turn had really ended, and `agentpane--let-go` in `emacs/agentpane.el` folds a not-streaming status into the watch (`agentpane--read-idle`, then `agentpane--watch-turn`), which raises the indicator as for an aborted turn.
After a gap the handle stays live and the turn goes on running on the server.
`agentpane--watch-turn`'s own docstring covers that case: "Where the handle stays live and this Emacs stops hearing it, keying alone is not enough, and the watch ends raising nothing", naming only `agentpane--detach` today.
The browser raises nothing for a gap: `detachGapped` in `src/client/controller.ts` deletes the view, and `watchSessions` in `src/client/favicon.ts` skips a session with no view and keeps waiting.
The Emacs client is at parity with the browser by the owner's rule of 2026-09-23 (AGENTS.md, "Both clients").

## What is load-bearing

`agentpane--let-go` cannot tell the two causes apart from `session/detached { session, handle }` as it stands, so the fix probably needs the helper to say which it was, a change to that notification's entry in `src/emacs/protocol.ts`, whose docblock logs each raise of the interface.
A server-side let-go must still raise the indicator as today, and the existing ert tests that pin that stay green.
OW-reyayi, case 2, asks whether a deliberate `agentpane-shutdown` should raise it, the same shape for a helper's exit; whatever this card builds to say "the handle stays live" may be what that decision reaches for, so read it first, but this card does not decide it.

## Done when

An ert test in `emacs/agentpane-test.el`, red first, arms a turn from a buffer no window shows, sees it streaming, delivers a `session/detached` as the helper sends it for a gap, and asserts that `agentpane-test--turn-done-p` is nil and the watch is gone.
If the helper's notification changes, a test in `src/emacs/helper.test.ts` asserts the gap's form of it and `dropDead`'s form stays as it was.
The `agentpane--watch-turn` and `agentpane--let-go` docstrings name the gap among the cases that raise nothing.
`bun run check` passes, and so does the ert suite.
