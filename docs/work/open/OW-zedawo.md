---
labels: [defect, emacs]
---

# agentpane-mode's helper death detaches only buffers whose attach reply was handled: one fed a handle by the attach's snapshot before the reply stays streaming under that handle, and a prompt in flight loses its turn-done watch

Filed 2026-09-28 from the adversarial read of OW-kakate, which made `agentpane--helper-gone` in `emacs/agentpane.el` leave each buffer attached through the dead helper as a `session/detached` leaves it, through `agentpane--let-go`.
Read D25 in `docs/DESIGN.md` first, point 4: any helper's death means every buffer it *served* is detached.

## The cause

`agentpane--helper-gone` picks the buffers to let go by `(eq (buffer-local-value 'agentpane--attached buffer) connection)`.
`agentpane--attached` is set only when an attach reply is handled (`agentpane--attached-as`), but a buffer is served earlier than that: `agentpane--on-notification` gives it a handle from the first notification that finds it, before the reply (see `agentpane--notified-buffer`'s docstring on D2 and jsonrpc.el's anxious continuations).
And jsonrpc.el on Emacs 31.1 (`/usr/share/emacs/31.1/lisp/jsonrpc.el.gz`, `jsonrpc--process-sentinel`) calls every pending request's error handler with "Server died" *before* it calls `:on-shutdown`, so by the time `agentpane--helper-gone` runs, each in-flight request's failure path has already run and `agentpane--attaching`, `agentpane--sending` and the like are cleared.
The selection key is therefore the wrong owner: it names "attach reply handled", not "fed by this connection".

## Cases

1. An attach answered by its snapshot but not its reply when the helper dies.
   A preview buffer sends `sessions/attach`; the `session/snapshot` under `h1` with `isStreaming t` arrives and the buffer takes the handle and draws the live transcript; the helper is killed before the reply.
   Measured by the reader on 2026-09-28 with a real `jsonrpc-process-connection` over `sleep 100`: the buffer ends holding `h1`, `agentpane--attached` nil, `agentpane--dropped` nil, `agentpane--attach-sent` t, still streaming, mode line ` [streaming · luna]` for good, the tool call still drawn running.
   `g` (`agentpane-refetch`) then sends `sessions/preview` and draws the stored transcript over the live one, which is what `agentpane--dropped` exists to prevent.
   A `session/detached` for `h1` would have dropped it, since `agentpane--notified-buffer` finds it by the handle, so the two causes still disagree.
   The same shape covers a fork child's attach, the attach a send makes from a preview (`agentpane--attached-then`), and `agentpane--attach-now` in `agentpane-new-session`.
2. A prompt in flight when the helper dies.
   Prompt sent, reply held; a `session/status` under `h1` with `isStreaming t` arrives and the turn-done watch reads `streamed`; the helper dies.
   The prompt's error handler runs first and abandons the watch as UNSENT (see `agentpane--request` and `agentpane--watch-turn`), so `agentpane--let-go` finds no watch and the turn-done indicator is never raised, where OW-kakate's commit says a turn seen streaming at a helper's death raises it as an aborted one does.
   Measured by the same reader: watches nil, turn-done nil.
   The root is that "Server died" is read as "reached no backend", which the UNSENT docstring does not cover.

Both cases predate OW-kakate; neither is a regression.
Keying the loop on `agentpane--attaching` cannot fix case 1, since the error handlers cleared it first, and keying on `agentpane--handle` alone would wrongly drop a Pi fork's parent, which keeps its handle while detached (see `agentpane--handle`'s docstring).
What is load-bearing is that the buffer set comes from what the connection fed, not from which reply was handled; the shape of that owner is the implementer's call.

## Done when

ERT tests in `emacs/agentpane-test.el`, red first, drive both cases through a real jsonrpc connection (as `agentpane-test-helper-death-detaches-every-buffer-it-served` builds one over `cat`, but without stubbing `jsonrpc-async-request`, so jsonrpc.el's error-handlers-before-`:on-shutdown` ordering actually runs) and assert: in case 1 the buffer ends as a `session/detached` for `h1` leaves it (no handle, not attached, dropped, idle); in case 2 the turn-done indicator is raised.
The `agentpane--attached`-keyed selection in `agentpane--helper-gone` is gone, replaced by whatever owns "buffers this connection fed".
The suite passes with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
OW-bukupu owns the late-reply-onto-a-replacement case and the `eq` guard; leave both to it.

## Amended 2026-09-28 after OW-bukupu

OW-bukupu settled case 1: `agentpane--on-notification` now records the connection that gave a buffer its handle in the buffer-local `agentpane--served-by`, and `agentpane--helper-gone` lets go of a buffer that either it or `agentpane--attached` names; `agentpane-test-snapshot-before-a-death-is-let-go` is the case-1 test, red on main.
The selection is therefore no longer keyed on `agentpane--attached` alone, though that key survives beside `agentpane--served-by`; whether one owner should replace both is this card's call.
Case 2 stands, with a changed order: jsonrpc.el's "Server died" is now handled from a zero-delay timer, behind the helper's queued messages and ahead of the teardown `agentpane--helper-exited` defers (see "Each request has one answer" in `agentpane--request`'s docstring), so the prompt's UNSENT still forgets the watch before `agentpane--let-go` could fold it.
Drop case 1 from the done-condition; case 2's test and the suite remain.
