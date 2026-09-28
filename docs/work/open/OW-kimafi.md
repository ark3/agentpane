---
labels: [deferral, emacs]
---

# Work chained off a dead helper's last messages is refused with "Error running timer" noise in the echo area, leaving a picker stale or a new fork buffer unshown

Recorded 2026-09-28 from OW-bukupu's implementer and the adversarial read of its third cut; by design, and judged not worth holding OW-bukupu for.

## What happens

Since OW-bukupu, `agentpane--connection` in `emacs/agentpane.el` signals `(error "The agentpane helper has exited")` while a helper that has exited awaits its teardown, which `agentpane--helper-exited` defers behind the messages the helper wrote last.
A handler of those messages that sends a request therefore signals inside a jsonrpc.el timer, which Emacs reports as `Error running timer: (error "The agentpane helper has exited")`.
Reproduced by the reader: the dead helper's last `sessions/changed` runs `agentpane--revert-pickers`, the refetch is refused, and the picker stays stale until `g`; `main` before OW-bukupu started a replacement helper and sent `sessions/list` through it.
By reading, the same refusal meets the re-attach after an attach reply merged two buffers (`agentpane--attach`), `agentpane--fork-at`'s attach of the new fork buffer (created but not shown, THEN skipped), the close reply's `sessions/list`, and a prompt waiting on an attach.
An interactive command meets it only between the death and Emacs's next wait, in practice typed-ahead input, and its message is clear.

## What is load-bearing

The refusal itself is not up for change: it is what keeps any helper from starting before the last one's teardown, and OW-bukupu's cases return without it.
What this card may change is how a refused request reads and what the user is left with: an echo-area line naming the helper's exit rather than a timer error, and a picker or fork buffer brought up to date once a helper is running again.

## Done when

An ERT test in `emacs/agentpane-test.el` drives a dead helper whose last messages are `sessions/changed` then `session/node`, with an `agentpane-sessions-mode` buffer open, and asserts no "Error running timer" is logged to `*Messages*` and the node is drawn (it is today; keep it so), red before, green after, plus whatever the chosen treatment of the stale picker asserts.
The suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
