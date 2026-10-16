---
labels: [defect, emacs]
blocked-by: [OW-kijuju]
closed: done
---

# An Emacs edit that forks drops the draft it displaced, and with it any words a Stop took out of the queue

Filed 2026-10-15 from OW-kijuju, under the "Both clients" rule in `AGENTS.md`.
OW-kijuju decided what happens to the draft an edit displaces in the browser, and `emacs/agentpane.el` still does the opposite.

## The decision, as the browser now implements it

Read the `editing` docblock in `src/client/App.svelte`, and the `stop` docblock and the release `$effect` below it, for the decision at the code.
In short:

- The edit's lifetime owns the displaced draft, not any one exit.
  Cancel replaces the composer with it, as before.
  Every other exit gives it back once no edit is open and no send is out, joined ahead of whatever the composer holds then, through the same single release that gives back what a Stop took out of Pi's queue.
  In the browser those exits are a fork that lands, a fork whose prompt fails after its attach, and a click to another session.
- Order, so every exit agrees with Cancel: the stopped words, then the displaced draft, then whatever else the composer holds.
  This holds whichever side of the edit's end the stop's answer lands on.
- A fork that fails before it lands leaves the edit open, displaced draft included.
- No edit opens while a send is out, and the edit-last shortcut that stops a streaming Pi turn ("Stop and edit") stops nothing when its edit does not open.

## What Emacs does instead

`agentpane--send-edit`'s success callback ends the edit with `agentpane--end-edit`, whose docstring reads "Close this buffer's edit, leaving the prompt region as it is".
The edit's `:draft` is then dropped.
`agentpane-cancel-edit` is the only path that puts `:draft` back.
`agentpane--release-queued` is already the one place that releases `agentpane--held-queued`, on the same "no edit and nothing in flight" condition as the browser's release, and it is the natural owner here too.

OW-seleri's adversarial read reproduced the worst case with a throwaway ERT experiment.
Stop (`agentpane-abort`), then `C-c C-e` (`agentpane-edit-last`) or `e` before the abort answers, holding `sessions/abort` and `sessions/forkPoints` and answering the abort first.
`agentpane--release-queued` joins the stopped texts into the prompt region, because `agentpane--edit` opens the edit only from the `sessions/forkPoints` callback.
The edit then opens and takes the region, stopped texts and all, as its `:draft`, and `C-RET`'s fork drops it.
The region ended empty, `agentpane--held-queued` nil, and nothing was on the kill ring.

Nothing in `agentpane--edit`, `agentpane-edit-last` or `agentpane--start-edit` refuses while `agentpane--sending` is set.
Because the edit opens asynchronously, the refusal belongs where the edit actually opens (`agentpane--start-edit`, or the forkPoints callback that calls it), not only at the key press.

## Copies of the old behaviour to retire in the same change

- The `agentpane-abort` docstring: "a fork drops that draft (OW-kijuju)", and the bullet "An edit's send drops the displaced draft".
- The `agentpane--absorb` docstring, where a merge carries OTHER's draft into the one this buffer's edit displaced: "Cancelling the edit puts both back; a fork drops both".
- The `agentpane--send-edit` docstring's account of what is released after SENT.

Grep `emacs/agentpane.el` for "drops" and ":draft" for any others.

## Done when

All three ERT tests live in `emacs/agentpane-test.el`, and each is seen red first.
Run them from the repository root as that file's header says: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

- An ERT test types a draft, edits an earlier message, forks with `C-RET`, lets the fork's prompt answer, and asserts the parent buffer's prompt region holds the typed draft.
- An ERT test runs OW-seleri's sequence above and asserts the stopped texts survive the fork in the prompt region, ahead of the displaced draft.
- An ERT test asserts no edit opens while a send from that buffer is in flight, and that `agentpane-edit-last` sends no `sessions/abort` then.
- The docstrings listed above no longer say a fork drops the draft.
- `bun run check` passes if anything under `src/` changed.

## Close note

Landed in `emacs/agentpane.el` on main as three commits citing OW-hakeno.

An Emacs edit's displaced draft now comes back on a fork, as the browser's does since OW-kijuju.
`agentpane--send-edit`'s success callback hands the edit's `:draft` to a new buffer-local, `agentpane--displaced`, just before `agentpane--end-edit`.
`agentpane--release-queued` stays the single release point, under the same "no edit, nothing in flight" condition.
It now joins the stopped prompts (`agentpane--held-queued`), then the displaced draft, then the region's text, so a fork leaves the region as Cancel would.
A fork or prompt that fails still leaves the edit open with its draft.
Merges needed no new code, because `agentpane--absorb` already folds the other buffer's draft into this edit's `:draft`.
No edit opens while a send from the buffer (or its composer) is in flight; the check sits in `agentpane--edit`'s fork-points callback, where the edit actually opens, and it skips THEN, so `agentpane-edit-last` sends no `sessions/abort` then.
It also stops an edit's own send from retargeting the edit, which would otherwise have left that edit open after the fork.
The docstrings that said a fork drops the draft are retired: `agentpane-abort`, `agentpane--absorb`, `agentpane--send-edit` and `agentpane-edit-last`.

Verified with ERT, run from the repository root as the test file's header says: 280 tests, 0 unexpected, 3 skipped, both on the branch and on main after the cherry-pick.
The four new tests failed red against the pre-change `agentpane.el`, or against a mutation:
- `agentpane-test-edit-fork-gives-the-displaced-draft-back`
- `agentpane-test-stop-then-edit-keeps-pis-queue-through-the-fork`, which is OW-seleri's sequence
- `agentpane-test-edit-opens-nothing-while-a-send-is-in-flight`
- `agentpane-test-edit-send-failed-keeps-the-displaced-draft`, red against a mutation that also released the draft on failure
Four existing tests that asserted the old drop now assert the new order.
`agentpane-test-edit-send-that-merges-leaves-no-draft-to-prompt` was renamed `...-gives-the-others-draft-back`; the closed OW-bifevo still cites the old name.
`agentpane-test-edit-send-while-a-prompt-is-in-flight-forks-nothing` was removed: its state, an edit open while a plain prompt is out, can no longer be reached.

The adversarial read found no sequence that loses or misplaces words.

Remaining differences from the browser, left as they are:
- The browser also gives the draft back when the fork's prompt fails after the fork's attach; Emacs leaves the edit open on any failure.
- The refusal arrives after a fork-points round trip rather than at the press.
- Unlike the browser, which holds the draft apart from the edit for the edit's whole life, Emacs keeps it in `:draft` and moves it out at this one exit, so a future caller of `agentpane--end-edit` must hand the draft over too.
Nothing under `src/` changed.
