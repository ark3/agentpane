---
labels: [defect, emacs]
closed: done
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
While OTHER's close is out, `agentpane--attached-as` (since OW-rebawa `agentpane--attach-by`, at the snapshot that answers the attach) merging OTHER into a buffer attaching the same session kills OTHER without reading its `agentpane--closing`; the survivor takes OTHER's handle and draft but not the close in flight, and its `agentpane-send` then sent `sessions/prompt` at once.
For a session with nothing on disk that prompt fails (`SessionManager.attach` in `src/server/http/session-manager.ts` answers `UnknownSessionError` once `close` has run), so nothing is lost but the close's own reply; for one on disk it would reach the session being closed.
Reaching it takes a second buffer on another name of the same live session inside the close's round trip, and once the close answers OTHER holds no handle, so no merge can happen in the listing gap after it.
Whatever remedy this card picks for a request dropped with OTHER, say in the close note whether it covers a close in flight.

Done when an ERT test in `emacs/agentpane-test.el`, run as that file's Commentary says, goes red before and green after: it has a buffer send `sessions/fork` through the fake helper, merges that buffer into another through the attach path `agentpane-test--merging` drives before the fork answers, answers the fork, and asserts that a buffer holding the forked ref exists and is attached.

## Amended 2026-09-28 under D25

Under D25 the prompt route no longer attaches first (OW-sirofi), so the close half above, a survivor's prompt reaching the session being closed, becomes a refused request rather than a respawn.
The fork half, a merge dropping a `sessions/fork` reply, stands.

## Amended 2026-10-15 from OW-seleri's adversarial read

A plain `sessions/abort` in flight is no longer harmless to drop.
Since OW-seleri, `agentpane-abort` reads its answer's `:queued`, the text of the prompts the Stop took out of Pi's queue (D16), into `agentpane--held-queued`, and does so only from the request's CALLBACK, which `agentpane--request` skips for a buffer killed before the answer.
`agentpane--absorb` hands the survivor what OTHER already holds, but an abort still out when OTHER is merged away loses its texts: Pi has already removed them from its queue, so they are in no session file either.
Found by reading only; the reader did not establish that a Pi session can be held under two refs in Emacs at once, which a merge needs, and the existing merge tests use Claude refs.
Whatever owner this card settles on for a dropped reply should cover the abort's too, or the close note should say why a Pi merge cannot reach it.

## Amended 2026-10-15 at execution

The done-condition's "fake helper" is, for this test, the stub `agentpane--request` that `agentpane-test--forking` installs (which `agentpane-test--merging` wraps), not `emacs/fake-helper.ts`.
As of this amendment that stub answers a held request with `(with-current-buffer from ...)` whether or not FROM is still live, so a fork answered after its buffer was merged away signals "Selecting deleted buffer" rather than being dropped as the real `agentpane--request`'s `:success-fn` drops it.
A test run against the stub as it stands would go red on that error, not on the missing fork buffer.
So the stub must first model the real drop -- CALLBACK and FAILED skipped for a killed buffer, UNSENT and REPLIED still run, as `agentpane--request`'s docstring says -- and the red the done-condition asks for is the assertion that no buffer holds the forked ref, seen with the stub corrected and the fix absent.

## Close note

A merge no longer drops the fork or stop that the merged-away buffer had in flight; the buffer that absorbed it answers them.
`agentpane--absorb` records OTHER -> survivor in `agentpane--absorbed`, and `agentpane--request` takes ALWAYS `follow`, under which CALLBACK, FAILED and ERRED run in `agentpane--absorber` of the sending buffer on reply, error, timeout and helper exit.
The whole fork chain follows (`sessions/forkPoints` through `agentpane--fork-point`'s new FOLLOW, Pi's pre-fork `sessions/abort`, `sessions/fork`), and so does `agentpane-abort`, so the `:queued` texts a stop takes out of Pi's queue land in the survivor's region.
Every other request still drops with its buffer, deliberately: a prompt's answer following would clear the survivor's own `agentpane--sending`.
Owner chosen: the survivor, which holds OTHER's handle and so, on Pi, is in the parent's position; the fork's reply detaches it, releasing its own and OTHER's tokens.
An edit send in flight goes on to the fork with its text; the echo area now says so, and the text still goes on the kill ring in case the fork or prompt fails.
Deliberately left: a `sessions/close` in flight in OTHER is not taken over (its answer drops, and the survivor holds the handle until the close's `session/detached`, D26), and a user killing a buffer outright drops its replies as before.
Whether a Pi session can actually be held under two refs in Emacs at once, which a Pi merge needs, is still unestablished; the Pi tests force it with `agentpane--hold-ref`.

Verified in `emacs/agentpane-test.el`, run as its Commentary says: 277 tests, 0 unexpected, 3 skipped.
The test stub in `agentpane-test--forking` was first made to drop a killed buffer's CALLBACK/FAILED/ERRED as the real `agentpane--request` does (card amended at execution for this), with the suite green on that alone.
`agentpane-test-fork-in-flight-follows-a-merge` then went red on `(should buffer)`, no buffer holding the forked ref, with the fix absent, and green with it; each piece of the fix reverted alone turned at least one of the new tests red (Claude and Pi fork across a merge, stop across a merge through the real `agentpane--request`, a fork failing after a merge, an edit send across a merge, a following request failing in the survivor on error and timeout).
No `src/` touched, so `bun run check` was not run.

The survivor also takes OTHER's `agentpane--forking`, a per-buffer flag copied at the merge.
The adversarial read showed by probe that it misses a case (an edit send waiting on the survivor's attach forks a second time, and the first answer clears the flag while the second is out) and, by reading, that no buffer-local flag can guard a sibling buffer on the same session; filed as OW-tukuvo, which replaces the copy with a per-session owner.
The docstrings now claim only what holds and cite it.
