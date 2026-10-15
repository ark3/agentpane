---
labels: [defect, emacs]
blocked-by: [OW-kijuju]
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
