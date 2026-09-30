---
labels: [deferral, emacs]
closed: moot
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

## Amended 2026-09-28 under D25's follow-up

D25's "What the run found, and the two ownership changes it asked for" in `docs/DESIGN.md` makes the teardown own a helper's death (OW-mopuyi) and the helper's notifications alone bind a buffer (OW-rebawa); this card stays, since the refusal it describes is OW-bukupu's and stands.
The owner agreed on 2026-09-28 how it should read: a refused chained request is dropped quietly, with no "Error running timer", and a picker left stale waits for `g`, as D25 point 4 already accepts.
The one thing kept from the user-facing list above: a fork buffer created in that window is still shown, detached, so `g` can bring it back rather than it staying hidden.
Write the done condition's "chosen treatment of the stale picker" as: nothing refetches it.

## Close note

Superseded by OW-hiliti, which landed 2026-09-29, and nothing is left over.
`agentpane--request` no longer lets `agentpane--connection`'s refusal signal: a request made through a helper that has exited, before its teardown, is sent nowhere, runs UNSENT at once, and is answered by the teardown as the death with one "failed: the helper exited" line, so no "Error running timer" appears.
The owner's 2026-09-28 treatment holds: nothing refetches a stale picker, and a fork buffer made in that window is shown, detached.
Tests, each red first: `agentpane-test-last-node-drawn-past-a-refused-refetch` (sessions/changed then session/node, with a sessions buffer open: no timer error, no request sent, the node drawn) and `agentpane-test-fork-answered-as-its-helper-dies-is-shown`.
