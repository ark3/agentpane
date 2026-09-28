---
labels: [defect, emacs]
closed: done
---

# agentpane-mode's helper shutdown callback clears agentpane--connection unconditionally, so a dead helper's late sentinel can orphan the helper that replaced it

Filed 2026-09-27 from the adversarial read of OW-dunahe; read at the code, not reproduced.

`agentpane--connection` in `emacs/agentpane.el` starts a new helper whenever `agentpane--connection` is nil or not `jsonrpc-running-p`, and gives each connection an `:on-shutdown` that sets `agentpane--connection` to nil.
Until OW-dunahe that callback was an inline lambda; OW-dunahe replaces it with `agentpane--helper-gone`, which keeps the unconditional `(setq agentpane--connection nil)` and adds per-buffer cleanup keyed by `eq` on the dead connection.

The case: the helper process exits, so `jsonrpc-running-p` already reads false, but jsonrpc's process sentinel, which calls `:on-shutdown`, has not run yet.
A command in that gap calls `agentpane--connection`, which starts a replacement and stores it.
The old sentinel then runs and sets `agentpane--connection` to nil, so the replacement keeps running and dispatching notifications while the next command starts a third helper beside it.

What is load-bearing: the shutdown callback must clear only the connection it was called for, e.g. `(when (eq agentpane--connection connection) ...)`.
Whether the gap is reachable at all depends on when Emacs 31.1 runs a process sentinel relative to `process-live-p` turning false; establish that first, and if it is unreachable, close this card with the evidence.

Done when an ERT test in `emacs/agentpane-test.el` that drives the late-sentinel order against a stub (the `agentpane-test-turn-done-watch-ends-with-the-helper` test shows how to stand up and kill a `cat` process as a helper) goes red before the change and green after, run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Landed on main as "fix(emacs): forget a dead helper's connection on its shutdown only while it is still the current one, so a late sentinel cannot orphan the replacement (OW-toyupa)".
The gap is reachable on Emacs 31.1: jsonrpc's `jsonrpc-running-p` is `process-live-p`, and a probe that SIGKILLed a `cat` and busy-waited without yielding read it not live with its sentinel, the only caller of `:on-shutdown`, not yet run; the sentinel ran at the next `accept-process-output` (measured 2026-09-28, recipe in the commit message).
`agentpane--helper-gone` now clears `agentpane--connection` only when it is still the connection being shut down; `agentpane--stream-down` stays cleared unconditionally, because `openStream` in `src/emacs/helper.ts` starts `down` false and notifies only transitions, so a replacement never undoes a dead helper's `reconnecting`.
New ERT test `agentpane-test-late-sentinel-keeps-the-replacement-helper` kills a `cat` helper, starts a replacement before the old sentinel runs, then lets it run; it went red with the guard removed (`should (eq agentpane--connection replacement)`) and green with it, and the Emacs suite ran 199, 0 unexpected, 3 skipped as on main.
The adversarial read found the guard is a check at the site and misses a family of cases: jsonrpc delivers messages through zero-delay timers after the sentinel can have run, so a dead helper's late attach reply binds a buffer to the replacement, its late `reconnecting` survives the reset, and the replacement's early one is erased by it.
Those, and the ownership change that retires this guard, are OW-bukupu.
