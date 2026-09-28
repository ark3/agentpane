---
labels: [defect, emacs]
closed: done
---

# agentpane-mode's turn-done watch lives on the transcript buffer and is fed by status edges, so a merge, a detach before streaming, a prompt timeout or a Pi fork's late status leaves it wrong

Filed 2026-09-27 from the adversarial read of OW-lohavi, under `AGENTS.md`, "Evidence", the sibling rule: the read named cases the site guards miss, so the state has the wrong owner.

The watch is `agentpane--turn-watch` in `emacs/agentpane.el`, a buffer-local `nil`/`sent`/`streamed`, armed in `agentpane--send-prompt` and folded by `agentpane--watch-turn` from `agentpane--set-status`; a raised buffer sits in `agentpane--turns-done` and is drawn by `agentpane--turn-done-lighter` in `global-mode-string`.
The browser's counterpart keys its watch by session handle (`TurnWatch.waiting` in `src/client/favicon.ts`, D24) and folds the streaming *level* of every session at every publish (`watchSessions`).
OW-lohavi already made arming fold the level (`(agentpane--watch-turn agentpane--streaming)` right after arming), which fixed a steer into a running turn; what remains comes from the watch being owned by a buffer and advanced only on `session/status` edges.

The guards at the site this card is to retire, or to show are still needed once ownership moves: "arm only if not already armed" and "disarm only the watch this prompt armed", both in `agentpane--send-prompt`'s `agentpane--attached-then` callback.

The cases, each read at the code and all but the last reproduced against a stub in the OW-lohavi review:

- **Merge.** `agentpane--absorb` kills the buffer whose handle an attach reply names; a watch armed there, or a raised entry in `agentpane--turns-done`, is dropped, so the turn's end reaches the surviving buffer unwatched, or an unseen turn's indicator clears.
  A prompt sent from the surviving buffer survives, since the merge's second attach sends a snapshot; losing it needs that buffer to have attached another way (`f`, or `g` on a dropped buffer).
- **Detach before streaming.** A `session/detached` (server restart, another client's Pi fork) between the prompt's admission and its first streaming status leaves the watch `sent`; after a re-attach a turn from elsewhere raises the indicator.
  A helper crash leaves it stuck from `sent` or `streamed`, and a stuck `streamed` makes the next prompt not arm.
  `agentpane--watch-turn`'s docblock states this as a known limitation.
- **Timeout.** The prompt's failure callback also runs when the reply outlasts `agentpane--spawn-timeout` (60s) or on a non-local exit via `agentpane--request`, where the turn may have been admitted; the watch is dropped and that turn's end raises nothing.
  `agentpane--send-prompt`'s docblock states this.
- **Pi fork.** If the aborted parent turn's not-streaming status arrives after `agentpane--fork-at` has handed the parent's window to the fork, the parent raises for a turn the user aborted on purpose; if it arrives after `agentpane--detach` stopped the helper forwarding the parent's handle, the parent is left `streamed`, as in the detach case.
  Read, not reproduced.

What is load-bearing is OW-lohavi's semantics, pinned by the `agentpane-test-turn-done-*` tests in `emacs/agentpane-test.el`: only a turn this Emacs submitted (or joined with a prompt) raises the indicator, and showing the session clears it.
Whether the fix keys the watch by handle, reads the level at more points, or both, is this card's to choose.

Done when an ERT test for each of the four cases goes red before the change and green after, in `emacs/agentpane-test.el`, run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`, the existing turn-done tests stay green, and the two docblock limitations above are gone or restated for whatever case is left and why.

## Close note

Landed 2026-09-27 on `main` as seven commits in `emacs/agentpane.el` and `emacs/agentpane-test.el`, the first `fix(emacs): key the turn-done watch by the session's handle, and end it wherever the handle stops being heard (OW-dunahe)`.

The watch moved off the buffer: the buffer-local `agentpane--turn-watch` is gone, replaced by the global alist `agentpane--turn-watches`, session handle to `sent`/`streamed`, as the browser's `TurnWatch` keys by handle (D24).
The raised indicator stays per buffer in `agentpane--turns-done`.
Per case:
- Merge: nothing moves, since the survivor holds the same handle.
  `agentpane--absorb` hands a raised indicator to the survivor only when no window shows it; a shown survivor would never clear it.
- Detach before streaming: handles carry a per-process random prefix (`#handlePrefix` in `src/server/http/session-manager.ts`) and are never minted twice, so a watch on a let-go handle is never read again.
  `session/detached` also drops it, which only keeps the list short.
  A helper exit (`agentpane--helper-gone`, the connection's `:on-shutdown`) ends every watch on the handles that helper carried and resets those buffers to not streaming via `agentpane--read-idle`.
- Timeout: `agentpane--request` gained `UNSENT`, which runs only when the request reached no backend (an error reply, or sending exited non-locally), whether or not the buffer still lives.
  A prompt abandons its watch there, so a timeout, or a non-local exit while handling an accepted reply, keeps the watch.
  The cost is stated in `agentpane--send-prompt`'s docblock: a timed-out prompt that was never admitted leaves a `sent` watch that the next turn from anywhere ends.
- Pi fork: `agentpane--fork-points` forgets the parent's watch as it sends the abort, which covers the usual order, status before the fork reply.
  `agentpane--detach` still forgets it too, for a parent whose turn was not yet seen streaming and for a killed buffer reopened under the same live handle.

Guards: "disarm only the watch this prompt armed" became identity abandon (`agentpane--watch-abandon` drops only the cons `agentpane--watch-submit` returned), which is what keeps a prompt refused mid-turn (D16) from disarming the running turn.
"Arm only if not already armed" stays as a join in `agentpane--watch-submit`, for a different reason than first claimed: it keeps one watch per handle, since a Codex steer's second entry otherwise raised the indicator at a later unrelated not-streaming status.
Pinned by `agentpane-test-turn-done-one-watch-per-handle`.

Verified on Emacs 31.1 with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`: 162 run, 159 expected, 0 unexpected, 3 skipped (pre-existing).
New tests: `agentpane-test-turn-done-survives-a-merge` (running, prompted, ended, ended-in-view), `-not-raised-after-a-detach-before-streaming`, `-watch-ends-with-the-helper` (both re-attach orders), `-kept-for-a-prompt-that-timed-out` (timeout, reply-exit, error, send-exit), `-not-raised-by-a-pi-fork` (before with the parent unshown, after, never, unstreamed), `-abandoned-by-a-refusal-after-a-merge`, `-one-watch-per-handle`, and `-watch-ends-with-a-killed-buffer`.
Each was red against main 78c08f3 or the first commit, and red again under a targeted mutation of its part of the fix.
An adversarial read of the first commit found the merge-refusal regression, the misattributed join guard, the shown-survivor indicator, the Pi abort ordering and two test overclaims; all were fixed before landing.

Filed from the review: OW-toyupa (the shutdown callback clears `agentpane--connection` unconditionally), OW-zikiga (the browser's `send()` loses a running turn's badge when a mid-turn prompt is refused), and OW-mirifa (`g` previews instead of re-attaching after the helper dies).
