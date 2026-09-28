---
labels: [defect, emacs]
closed: done
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

## Close note

`agentpane-refetch` now re-attaches when `(or agentpane--attached agentpane--dropped)` instead of `(or (agentpane--attached-p) agentpane--dropped)`.
`agentpane--attached` is written only through `agentpane--hold-attached`: set when an attach answers, cleared by `session/detached`, a close, and a Pi fork, and left standing by `agentpane--helper-gone`.
So a value that is set but no longer the running connection means exactly "held live through a helper that has since exited", and the rule is read from that existing state rather than by setting `agentpane--dropped` at helper death, which would have claimed the helper said the handle was gone when it said nothing.
The docblocks of `agentpane--attached`, `agentpane-refetch` and `agentpane--helper-gone` say so.
Verified by `agentpane-test-refetch-attaches-again-after-the-helper-dies`: it kills a real `cat` helper so the jsonrpc sentinel runs `agentpane--helper-gone`, then asserts `g` sends `sessions/attach`. It failed with `sessions/preview` against the old condition and passes after; the full ERT suite ran 200 tests, 197 as expected, 3 interactive-only skips. Emacs Lisp only, so `bun run check` was not run.
The adversarial review found `agentpane-close-session` still gates on `agentpane--attached-p` and refuses such a buffer; filed as OW-vayeze.
