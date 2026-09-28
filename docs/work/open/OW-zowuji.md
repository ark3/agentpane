---
labels: [deferral, emacs]
---

# agentpane-mode's turn-done tests leave their indicator entry in the global global-mode-string for every later test

Filed 2026-09-27 while executing OW-ratati, from the implementer's report.

`agentpane-test--submitting` in `emacs/agentpane-test.el` let-binds `agentpane--turns-done` but not `global-mode-string`.
So each `agentpane-test-turn-done-*` test that raises the indicator runs `agentpane--watch-turn` in `emacs/agentpane.el` against the global value, and the `(:eval (agentpane--turn-done-lighter))` entry it adds stays there for the rest of the batch run.
The duplicate is skipped by `add-to-list`, and the lighter draws nothing once `agentpane--turns-done` is empty, so no test is known to be wrong because of it today; it is shared state between tests, and a test that inspects `global-mode-string` (as `agentpane-test--turn-done-p` does) reads what earlier tests left.
The OW-ratati test `agentpane-test-turn-done-raised-beside-a-users-own-construct` already let-binds it itself, which is the shape the macro could take for all of them.

Done when `global-mode-string` after a batch run of `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit` equals its value before the run (for example, checked by a final test or an `--eval` after the run), and the suite stays green.
