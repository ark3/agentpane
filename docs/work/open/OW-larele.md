---
labels: [defect, emacs]
---

# A merge that kills a transcript buffer with a sessions/fork in flight drops the fork's reply, so the fork is made on the server and no buffer ever opens on it

Found by the adversarial read of OW-bifevo on 2026-09-28, by reading and a throwaway probe; not reproduced against a real backend.

`agentpane--absorb` in `emacs/agentpane.el` kills the transcript buffer OTHER whose handle an attach reply names, and its docstring says "Requests of OTHER's still in flight are dropped with it, as any killed buffer's are".
That is `agentpane--request`'s `:success-fn`, which runs the callback only `(when (buffer-live-p buffer)`.
For `sessions/fork`, sent by `agentpane--fork-at` from the parent buffer (reached from `agentpane-fork`, and from `agentpane--send-edit` through `agentpane--fork-points`), the dropped callback is the whole client side of the fork: it clears `agentpane--forking`, detaches a Pi parent, and creates, attaches and shows the fork's buffer, then runs THEN, which for an edit sends the fork's prompt.
So a merge that lands while OTHER's fork is in flight leaves a fork the server made and no buffer on it, and for an edit the edited text never reaches the fork's prompt (OW-bifevo puts OTHER's region text on the kill ring, which is the only copy left).

The reader also claimed, by reading only, that on Pi the parent's live process moves to the fork (`SessionManager.fork` and `#adoptRef` in `src/server/`, and the Pi fork facts in `AGENTS.md` under "Evidence"), so the survivor would think it holds a handle that hears nothing more.
Verify that before building on it.

What is load-bearing is that a fork the server made while its requester was merged away ends up with a buffer, or is known not to have happened; which buffer owns the reply, the survivor or none, is open.
The same drop applies to `sessions/forkPoints` and a Pi `sessions/abort` sent before the fork, which are harmless on their own, and to a user killing the buffer outright, where the kill detaches and the fork's fate is a separate question -- say in the close note whether that case was deliberately left.

The adversarial read of OW-watawe on 2026-09-28 named the same drop for a `sessions/close` in flight, reproduced with a throwaway ERT probe and not against a real backend.
While OTHER's close is out, `agentpane--attached-as` merging OTHER into a buffer attaching the same session kills OTHER without reading its `agentpane--closing`; the survivor takes OTHER's handle and draft but not the close in flight, and its `agentpane-send` then sent `sessions/prompt` at once.
For a session with nothing on disk that prompt fails (`SessionManager.attach` in `src/server/http/session-manager.ts` answers `UnknownSessionError` once `close` has run), so nothing is lost but the close's own reply; for one on disk it would reach the session being closed.
Reaching it takes a second buffer on another name of the same live session inside the close's round trip, and once the close answers OTHER holds no handle, so no merge can happen in the listing gap after it.
Whatever remedy this card picks for a request dropped with OTHER, say in the close note whether it covers a close in flight.

Done when an ERT test in `emacs/agentpane-test.el`, run as that file's Commentary says, goes red before and green after: it has a buffer send `sessions/fork` through the fake helper, merges that buffer into another through the attach path `agentpane-test--merging` drives before the fork answers, answers the fork, and asserts that a buffer holding the forked ref exists and is attached.
