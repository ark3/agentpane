---
labels: [deferral, emacs]
---

# agentpane-mode ignores an error reply a helper wrote just before dying and answers the request as the death, so a refused prompt's turn-done watch survives and the teardown can raise the indicator for a turn from elsewhere

Filed 2026-09-28 from the adversarial read of OW-mopuyi, which made `agentpane--helper-gone` in `emacs/agentpane.el` answer every request a dead helper had out (`agentpane--requests-out`, `agentpane--answer-deaths`), running each request's FAILED and never its UNSENT.
Read D25 in `docs/DESIGN.md`, the paragraph "What the run found, and the two ownership changes it asked for", and the "Each request has one answer" paragraph of `agentpane--request`'s docstring, first.

## What happens

`agentpane--request`'s `:error-fn` now does nothing when `(jsonrpc-running-p connection)` is nil ("Past the helper's death, the teardown answers").
So an error reply the helper wrote just before it died, and which Emacs handles once the process already reads as not live, is not treated as a refusal. The teardown answers it as the death: FAILED runs, UNSENT does not, and the helper's own error message is not shown.
For a prompt, UNSENT is what abandons its turn-done watch (`agentpane--send-prompt`, `agentpane--watch-abandon`).
Reproduced by the reader in batch Emacs 31.1 with jsonrpc.el 1.0.29 on 2026-09-28: a `session/status` under `h1` reports a turn from elsewhere streaming, then the helper refuses this Emacs's prompt with an error reply and exits. The watch survives, and `agentpane--let-go` at the teardown raises the turn-done indicator for a turn this Emacs never started and which has not ended.
Before OW-mopuyi, UNSENT dropped the watch and nothing was raised.

## Why it is deferred

Three things have to line up: a refusal, a turn from elsewhere already streaming on the same handle, and the helper's death landing in the same pass as the refusal.
The cost is a spurious red dot, which clears when a window shows the buffer.
`agentpane-test-late-error-reply-fails-once` in `emacs/agentpane-test.el` asserts the current behaviour (FAILED once, UNSENT zero).

## Done when

This card is picked up only if the spurious indicator is seen in use, or if the case turns out to be wider than the reader found.
The fix would let a request's answer tell an error reply from the death: a refusal runs UNSENT whether or not the helper is still alive.
The check is an ERT test through a real process connection, red first, that drives the ordering above and asserts no turn-done indicator.
