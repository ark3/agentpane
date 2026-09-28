---
labels: [change, emacs, d25]
---

# agentpane-mode leaves a buffer whose helper died holding its attachment as a marker, a state of its own beside the one session/detached leaves; a helper's death should leave every buffer as session/detached does

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, which the owner took that day; read D25 first.

## What happens

When the helper process exits, `agentpane--helper-gone` in `emacs/agentpane.el` ends each attached buffer's turn-done watch and reads it idle, but leaves `agentpane--attached` standing, as a marker that the session may still be live on the server, so that `agentpane-refetch` attaches again rather than previewing (OW-mirifa).
That is a second "not really attached" state beside the one a `session/detached` leaves (`agentpane--dropped`), and code that reads one and not the other disagrees: OW-vayeze, closed moot into this card, is `agentpane-close-session` refusing such a buffer while `agentpane-refetch` treats it as live.
OW-mirifa's close note records why it did not set `agentpane--dropped` at a helper's death: that would claim the helper said the handle was gone when it said nothing.
D25 reverses that on purpose: a helper's death means every buffer it served is detached, whatever the cause, since a crashed helper over a live server is rare and costs a `g`.

## The change

At a helper's death, each buffer attached through it ends in the state a `session/detached` for its handle leaves it in, through the same code rather than a parallel path, and `agentpane--attached` is not left standing as a marker.
`agentpane--attached`'s, `agentpane--dropped`'s and `agentpane-refetch`'s docstrings stop describing the helper-death case as its own; OW-mirifa's reason is superseded by D25, which the docstring may cite.
What `g` does on such a buffer follows from `agentpane--dropped` and is not this card's to change.
The `eq` guard OW-toyupa put in `agentpane--helper-gone` is OW-bukupu's to retire, not this card's.

## Done when

An ERT test in `emacs/agentpane-test.el`, red first, attaches two buffers through a fake helper, ends the helper's process, and asserts each buffer is in the state a `session/detached` for its handle leaves it (read the existing `session/detached` tests for what that state is), and that `agentpane-close-session` and `agentpane-refetch` treat it alike.
The OW-mirifa tests are changed to match and named in the commit message.
The suite passes with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
