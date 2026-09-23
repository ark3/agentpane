---
labels: [defect, emacs, emacs-native]
closed: done
---

# agentpane-mode sends a second sessions/attach when set-model, compact or a send starts while another attach is in flight, and one attach failing clears the in-flight flag for all

Filed 2026-09-22 from the implementer's report and the adversarial read of OW-yoyiya; each item reasoned from `emacs/agentpane.el`, none probed live.
In service of a transcript buffer having at most one attach in flight, so that the guards OW-yoyiya added mean what their docstrings say.

OW-yoyiya added two buffer-local flags in `emacs/agentpane.el`: `agentpane--sending`, which refuses a second prompt while one is out, and `agentpane--attaching`, which makes `agentpane-refetch` send nothing while an attach is out.
Neither makes `agentpane--attached-then` coalesce attaches, and that is what is left:

- **A second attach.** `agentpane-set-model` and `agentpane-compact` go through `agentpane--attached-then`, which checks only `agentpane--attached-p`, so either one run while a first-prompt attach is in flight sends another `sessions/attach`.
- **A synchronous attach beside an asynchronous one.** Since OW-kisemu, `agentpane-set-model`'s `interactive` spec attaches through `agentpane--attach-now` (synchronous, as `agentpane-new-session` does) when `agentpane--attached-p` is nil, without consulting `agentpane--attaching`, so it too sends a second attach while a first prompt's is in flight.
- **One flag, several attaches.** `agentpane--attaching` is a single boolean that each attach's reply or FAILED hook clears.
  If two attaches are out and the first fails, the flag clears while the second is still pending, and a `g` in that window sends `sessions/preview`, which can draw the stored transcript over the live one — the hazard OW-yoyiya closed.
- **The Pi fork's parent redraw.** The Pi branch of `agentpane--fork-at` clears `agentpane--attached` and calls `agentpane-refetch` to redraw the parent from the store (see `agentpane-fork`'s docstring, and OW-zovaye for why it exists).
  If the parent has an attach in flight at that moment, that refetch now sends nothing; if the server handled that attach before the fork but its reply lands after, the parent keeps the fork's shortened transcript and marks itself attached again, until the next attach.
- **A silent `g`.** `g` while attaching does nothing and says nothing, and is not replayed if the attach fails.
  Decide whether that deserves a message.

Since filing, OW-gekiki made `agentpane-fork` refuse with a user-error while `agentpane--attaching` is set, so `f` is not a source of a second attach; `g` on an attached buffer still re-attaches through `agentpane--attach`, so a `g` during a Pi fork in flight is how the fork's parent can have an attach out when the fork's reply lands.

Load-bearing: whatever replaces the flag must still be cleared on every failure and timeout, including `agentpane--request` signalling synchronously, or it wedges the buffer; OW-yoyiya's tests in `emacs/agentpane-test.el` (`agentpane-test-one-send-at-a-time` and its neighbours) are the prior art for driving held replies through the `agentpane-test--forking` stub.

## Done when

An ert test in `emacs/agentpane-test.el` runs `agentpane-set-model` (or `agentpane-compact`) while a send's attach is held and asserts exactly one `sessions/attach` goes out, red before the fix.
A second holds an attach, starts a second caller that needs it (a send, `agentpane-set-model` or `agentpane-compact`), fails the held attach, and asserts the queued caller's failure path ran and a refetch while the attach was held sent no `sessions/preview`, red before the fix.
(Amended 2026-09-22 at execution: the card first asked for two attaches held at once, which coalescing makes unreachable.)
The Pi fork case either gets a test, or a sentence in `agentpane-fork`'s docstring saying why it cannot arise once attaches coalesce.

## Close note

Landed on main as the one OW-yibimi commit after fb65ccf ("fix: keep one attach in flight per transcript buffer"), in `emacs/agentpane.el` and `emacs/agentpane-test.el`.

- `agentpane--attaching` is now the list of callers waiting on the one attach in flight, each `(THEN . FAILED)`; `agentpane--attach` queues onto an attach already out rather than sending another, so send, compact and set-model through `agentpane--attached-then` coalesce with no change there.
  `agentpane--attach-answered` ends the wait and runs every waiter's THEN, or every FAILED; if one waiter exits non-locally, the rest still get their FAILED, so `agentpane--sending` never outlives the attach.
- The synchronous `agentpane--attach-now` (set-model's interactive spec) refuses with a user-error while an asynchronous attach is out, rather than blocking Emacs on it or sending a second.
- The Pi fork case is reachable after coalescing (a `g` on the attached parent during a fork is one legitimate re-attach), so `agentpane-refetch` now sends nothing while `agentpane--forking` is set; the Pi branch clears that flag before its own redraw from the store.
  Recorded in `agentpane-fork`'s docstring.
- `g` while attaching or forking now says why in the echo area; a message, not a user-error, because `agentpane-show-transcript` goes through `agentpane-refetch` and an error would leave the buffer unshown.
  It is not replayed after a failed attach.

Verified by ert, 41/41 on Emacs 31.1: `agentpane-test-one-attach-at-a-time` was red with four `sessions/attach` sent; `agentpane-test-failed-attach-fails-every-waiter` red with `agentpane--sending` left set; `agentpane-test-refetch-during-a-fork-sends-nothing` red with the Pi parent marked attached again by a late re-attach reply; `agentpane-test-waiter-that-signals-frees-the-rest` shown red by removing the new cleanup.
The Done-when's second item was amended at execution, since coalescing makes two attaches held at once unreachable.
Not run live.
