---
labels: [defect, emacs]
---

# agentpane-refetch previews rather than re-attaches a buffer whose helper died, drawing the stored transcript over a session still live on the server

Filed 2026-09-27 from the OW-dunahe implementer's report; the branch it names is confirmed by reading `agentpane-refetch` in `emacs/agentpane.el`, not reproduced against a running helper.

`agentpane-refetch` (`g`) re-attaches when `(or (agentpane--attached-p) agentpane--dropped)`, and otherwise sends `sessions/preview`.
Its docblock says why: "a preview would draw the stored transcript over the live one".
When the helper exits, `agentpane--attached-p` goes false, because it requires `agentpane--attached` to be `eq` to the running `agentpane--connection`.
But nothing sets `agentpane--dropped`: only the `session/detached` branch of `agentpane--on-notification` does.
So after a helper crash, or `agentpane-shutdown`, `g` in a buffer that was attached takes the preview branch, although the session may still be running on the server.

OW-dunahe added `agentpane--helper-gone` as the connection's `:on-shutdown`; it visits exactly the buffers whose `agentpane--attached` is the dead connection, and is the natural place to mark them the way `session/detached` does, if that is the fix chosen.
What is load-bearing is `agentpane-refetch`'s stated rule, that a session this buffer held live is re-attached rather than previewed; whether the fix sets `agentpane--dropped` there or widens the refetch's test is this card's to choose.

Done when an ERT test in `emacs/agentpane-test.el` that kills a stub helper under an attached buffer and then calls `agentpane-refetch` and asserts a `sessions/attach` was sent, not `sessions/preview`, goes red before the change and green after (`agentpane-test-turn-done-watch-ends-with-the-helper` shows how to stand up and kill a `cat` process as the helper), run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
If it lands before OW-dunahe, the helper-death hook to extend is the inline `:on-shutdown` lambda in `agentpane--connection`.
