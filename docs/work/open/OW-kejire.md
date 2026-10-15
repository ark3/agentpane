---
labels: [defect, emacs]
---

# agentpane-mode drops a handled prompt's turn watch only in the prompt's reply callback, so a merge before the reply, a reply past the timeout, or a turn seen before the reply escapes it

Filed 2026-10-14 from the adversarial read of OW-taviju (commit "emacs: a prompt the backend handled drops this buffer's turn watch and says no turn started (OW-taviju)"); cases (1) and (3) were confirmed by running probe ERT tests, case (2) by reading.

OW-taviju made `agentpane--send-prompt` in `emacs/agentpane.el` abandon the turn-done watch its prompt armed when `sessions/prompt` answers `(:disposition "handled")` -- a Pi extension command such as `/mcp` that starts no turn.
The abandon is a check in the prompt's success callback, the site where the symptom showed, while the watch itself lives in the global `agentpane--turn-watches`, keyed by handle (`agentpane--watch-submit`, `agentpane--watch-turn`).
It misses three cases, each leaving the indicator raised for a turn this Emacs did not ask for:

1. A merge (`agentpane--absorb`) kills the sending buffer before the handled reply arrives.
   `agentpane--request` runs no success callback for a killed buffer, while its UNSENT path, which a refusal takes, runs whether or not the buffer lives, so the watch stays `sent` on the handle the survivor holds and the next turn from elsewhere raises the indicator.
   Reproduced by adapting `agentpane-test-turn-done-abandoned-by-a-refusal-after-a-merge` in `emacs/agentpane-test.el` to answer handled after the holder is killed.
2. A handled reply that outlasts `agentpane--spawn-timeout` is discarded, so the watch stays `sent`, as the `agentpane--send-prompt` docblock already accepts for a timed-out prompt in general; nothing there extends that to the handled case, and the draft and the "handled" line are not updated either.
3. On `pi 1.2.0` an extension command's handler runs before Pi answers `handled`, so a handler that starts a turn through `pi.sendUserMessage` (Pi's `/ask` example) streams that turn before the reply, and another client's turn can likewise beat it.
   A turn that starts and ends before the reply has already raised the indicator, which the abandon at the reply cannot undo; one still streaming at the reply is dropped as decided.
   The `agentpane--send-prompt` docblock carries the caveat since OW-taviju; this card decides what that order does.

The browser has the same answer-after-events case at `disarmSubmit` in `src/client/App.svelte`, and OW-zikiga owns it there; whatever this card decides for the order should match what OW-zikiga records in `disarmSubmit`'s docblock (`AGENTS.md`, "Both clients"), so read OW-zikiga's close note if it has closed.

The fix moves the handled outcome to the owner of the watch rather than the reply site: the watch, or `agentpane--request`'s outcome handling, learns that its prompt was handled whether or not the sending buffer still lives, and the decision for the events-before-reply order is recorded in the `agentpane--send-prompt` and `agentpane--watch-submit` docblocks.

## Done when

ERT tests in `emacs/agentpane-test.el`, each red first, cover case 1 (a handled reply after a merge killed the sender raises nothing at the next turn from elsewhere) and case 3 (a turn's events before a handled reply do whatever the docblock now says), and case 2 is either covered by a test or its cost stated in the `agentpane--send-prompt` docblock beside the timed-out prompt's.
The abandon in `agentpane--send-prompt`'s success callback is gone, replaced by the owner's handling, not joined by a second check.
The suite passes under `emacs --batch -L emacs -l ert -l agentpane -l emacs/agentpane-test.el -f ert-run-tests-batch-and-exit`, which `bun run check` does not run.
