---
labels: [change, emacs, d25]
closed: done
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

## Close note

Landed as e996442 on main (2026-09-28).
The `session/detached` branch of `agentpane--on-notification` became `agentpane--let-go`, and `agentpane--helper-gone` calls it for each buffer attached through the dead connection: the buffer holds no handle, is not attached, is dropped, and reads idle, so `agentpane-close-session` refuses it and `g` attaches it again as for any detached buffer.
`agentpane--attached` is no longer left on a dead connection as OW-mirifa's marker; D25 point 4 supersedes that rule, and the docstrings of `agentpane--helper-gone`, `agentpane--on-notification`, `agentpane--read-idle`, `agentpane--attached`, `agentpane--dropped`, `agentpane--handle`, `agentpane-refetch` and `agentpane--watch-turn` say so.
One consequence of sharing the path: a turn seen streaming when the helper dies now raises the turn-done indicator, as an aborted turn does at a `session/detached`.
Verified: `agentpane-test-helper-death-detaches-every-buffer-it-served` replaces the OW-mirifa test `agentpane-test-refetch-attaches-again-after-the-helper-dies`, and was red against main's `agentpane.el` on `(should-not agentpane--handle)` reading "h1"; `agentpane-test-turn-done-watch-ends-with-the-helper` and `agentpane-test--reattach-after-helper-death` now expect the indicator at the death; the ERT suite ran 200 tests, 197 as expected, 3 skipped as on main.
The OW-toyupa `eq` guard and the `reconnecting` machinery were left to OW-bukupu and OW-mepufi.
The adversarial read found that the selection key misses a buffer fed a handle by its attach's snapshot before the reply, and a prompt in flight whose watch jsonrpc.el's error-before-shutdown ordering abandons, both pre-existing: filed as OW-zedawo.
It also found two cases where the helper's death is no crash, a close in flight and a deliberate `agentpane-shutdown`, filed as the question OW-reyayi.
