---
labels: [defect, emacs]
---

# agentpane-close-session refuses a buffer whose helper died under it, though agentpane-refetch now treats that buffer as holding its session live

Filed 2026-09-28 from the adversarial review of OW-mirifa; the gate it names is confirmed by reading `agentpane-close-session` in `emacs/agentpane.el`, not reproduced against a running helper.

OW-mirifa made `agentpane-refetch` (`g`) re-attach a buffer whose `agentpane--attached` is still set but is no longer the running connection, which is exactly a buffer whose helper exited under it (crash, or `agentpane-shutdown`): `agentpane--helper-gone` leaves `agentpane--attached` standing, and only a `session/detached`, a close, or a Pi fork clears it.
`agentpane-close-session` still gates on `(not (agentpane--attached-p))`, so in that same buffer it answers "This session is not attached; there is nothing to close", although the session may still be running on the server and `g` treats it as live.
The user has to press `g` before a close will go out.
Its docblock's reason for the refusal, "a session this buffer has not attached, for there is nothing of its own to close", is false for such a buffer, which did attach.

What is load-bearing is that close and refetch agree on which buffers hold a live session.
Whether close attaches first (as `agentpane--attached-then` does for sends, compact, and non-interactive set-model and set-effort), or sends `sessions/close` by ref through the new helper, is this card's to choose; the close request already carries `:handle` only when `agentpane--handle` is set, and a replacement helper does not know the dead one's handle.
The same review noted that the "only previewed" wording in the docblocks of `agentpane-fork` and `agentpane-edit` no longer names every buffer their attach-first branch serves; correct them if this change touches that vocabulary.

Done when an ERT test in `emacs/agentpane-test.el`, modelled on `agentpane-test-refetch-attaches-again-after-the-helper-dies` (which stands up and kills a `cat` helper under an attached buffer), calls `agentpane-close-session` after the helper dies and asserts a close-path request was sent rather than the `user-error`, going red before the change and green after, run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
