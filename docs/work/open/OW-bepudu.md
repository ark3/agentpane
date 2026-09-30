---
labels: [change, emacs, sweep-0929]
---

# At a seq gap agentpane-mode keeps a streamed turn-done watch for a re-attach to end, which the owner judged not worth its state: a gap should drop the watch, as a shutdown does

Filed 2026-09-30 from OW-nuzoto's landing, whose adversarial read filed OW-wufiro for the state the kept watch left without an owner.
The owner decided the same day that a gap gets the treatment OW-nuzoto gave a deliberate shutdown: nothing raised and the watch dropped, `streamed` or not.
The case given up is a turn that a gap cut off, re-attached from the same buffer while still running, and ended with no window showing it; it needs a gap, which D25 reads as something already wrong, then a re-attach mid-turn, and costs one missed indicator.
OW-wufiro closed declined under this card, and the browser makes the same change in OW-jadoda, so the two clients still agree.

## Where it is

`agentpane--let-go` in `emacs/agentpane.el` settles the watch by its CAUSE: the `gapped` arm calls `agentpane--watch-forget-sent`, which keeps a `streamed` watch, where the `shutdown` arm calls `agentpane--watch-forget`.
Make `gapped` do what `shutdown` does.
`agentpane--watch-forget-sent` then has no caller and goes.

## Where it is recorded

Whichever of this card and OW-jadoda lands first writes the decision into D25 point 5 in `docs/DESIGN.md` ("A sequence gap detaches that one session, in either client"), and the second checks it says both clients: a gap ends the turn-done watch on that handle raising nothing, in both clients, and why the re-attach case was given up.
The docstrings of `agentpane--let-go` and `agentpane--watch-turn` stop saying a `streamed` watch survives a gap for a re-attach, and `agentpane--watch-turn`'s note that a kept watch cannot tell its own turn from a later one goes with it.

## Done when

- `agentpane-test-turn-done-raised-after-a-gap-and-a-reattach` in `emacs/agentpane-test.el` is turned round, red first against the current code: after a gapped `session/detached`, a re-attach under the same handle that streams and stops raises nothing, and no watch remains on the handle from the gap on.
- `agentpane-test-shutdown-drops-a-watch-a-gap-kept` either goes, a gap now keeping nothing for a shutdown to drop, or is kept with a docstring saying what it still holds; the implementer's call.
- Still green: `agentpane-test-turn-done-not-raised-by-a-gap`, `agentpane-test-turn-done-not-raised-after-a-gap-before-streaming`, `agentpane-test-turn-done-raised-when-the-server-lets-go` and `agentpane-test-turn-done-not-raised-by-a-shutdown`.
- The ERT suite (`emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`) and `bun run check` pass.
