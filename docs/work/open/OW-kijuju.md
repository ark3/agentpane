---
labels: [defect]
blocked-by: [OW-fahoti]
---

# A fork that lands drops the draft the browser's edit displaced, so text typed before clicking edit is lost

Filed 2026-10-15 from OW-fahoti's execution, whose implementer and adversarial reader both read it in `src/client/App.svelte`; not reproduced in a browser.

`startEdit` stashes whatever the composer held as `editing.stashedDraft` (OW-hezidi, made once-per-mode by OW-bigotu), and the `editing` docblock says the stash is "put back by Cancel".
Cancel is the only exit that puts it back.
When the edit is submitted, `forkAndSubmit` in `src/client/controller.ts` moves the selection to the fork, and the pane-switch `$effect` in `App.svelte` sets `editing = null` with the comment "The displaced draft is not restored here -- switching sessions has never rewritten the composer, and this is a switch"; the `.then` in the edit branch of the composer's send path sets it null again once the fork lands.
So a user who types a note, clicks edit on an earlier message and forks loses the note: the composer ends empty once the fork's prompt clears the sent text.
OW-hezidi's own constraint was that a draft typed before clicking edit must not be lost (its "Stash it and restore on cancel"); the fork path was never decided, and nothing in the deck records a choice to drop it.

A second case of the same state, found by the same read: while a fork's prompt is still out and the selection has already moved onto the fork, "Edit last message" and the transcript's edit control are live, so `startEdit` stashes the text that prompt is sending; the prompt lands, finds the draft no longer equal to its text and leaves it, and Cancel then puts back a message that was already sent.

The owner of the question is the edit's lifetime, not either exit: decide where the displaced draft goes when an edit ends by forking — back in the composer once the fork's prompt settles is the obvious candidate, and OW-fahoti's `heldQueued` release in `App.svelte` already waits for exactly that moment — and whether an edit may open while a send is out.
Say the decision in the `editing` docblock.
Under the "Both clients" rule in `AGENTS.md`, check what `emacs/agentpane.el` does with its displaced draft on C-RET (OW-kihisa's fork-from-edit) and file an `emacs` card blocked by this one if it differs from the decision.

## Done when

- A test in `src/client/App.test.ts`, red first, types a draft, edits an earlier message, forks, lets the prompt land, and asserts the typed draft is where the decision put it.
- A test in `src/client/App.test.ts`, red first, opens an edit while a fork's prompt is still out and asserts Cancel does not put the sent text back, or that the edit cannot open, per the decision.
- `bun run check` passes.

## Amended 2026-10-15 from OW-seleri's adversarial read

The same drop loses the words a Pi Stop took out of the queue in Emacs, where the edit opens only once `sessions/forkPoints` answers: `agentpane--edit` calls `agentpane--start-edit` from that request's callback.
Stop (`agentpane-abort`) and then `C-c C-e` (`agentpane-edit-last`) or `e` before the abort answers: the abort usually answers first, finds no edit open, and `agentpane--release-queued` joins the stopped texts into the prompt region; the edit then opens and takes the region as its `:draft`, and `C-RET`'s fork drops that draft, stopped texts and all.
The reader reproduced it with a throwaway ERT experiment, holding `sessions/abort` and `sessions/forkPoints` and answering the abort first; the region ended empty, `agentpane--held-queued` nil, and nothing on the kill ring.
The browser opens its edit synchronously and so holds those words in `heldQueued`, but it drops them the same way when the Stop answers before the edit click.
So the decision this card takes about the displaced draft decides the stopped words too, in both clients; the `emacs` card this card files should carry an ERT test of exactly this sequence, red first, asserting the stopped texts survive the fork where the decision puts the draft.
