---
labels: [deferral, emacs, sweep-0929]
closed: done
---

# A composer buffer outlives the transcript it sends to, and a send from it then fails with 'Not an agentpane transcript or composer buffer'

Named by OW-watawe on 2026-09-27 as out of its scope, and confirmed by the adversarial read of OW-watawe on 2026-09-28 with a throwaway ERT probe.
Left because the composer's text is not lost, only stranded: the buffer stays live with it.

`agentpane-prompt` in `emacs/agentpane.el` makes a composer buffer whose `agentpane--composer-transcript` names the transcript it sends to.
Nothing kills or rebinds the composer when that transcript goes, whether the user kills it, `agentpane-close-session` kills it for having nothing on disk (OW-vasubu), or a merge kills it, though `agentpane--absorb` does hand a composer over to the survivor.
`agentpane--transcript` then finds the transcript not live and signals the user error "Not an agentpane transcript or composer buffer" at any command sent from the composer, which names neither the cause nor where the text can go.

In service of a user whose transcript has gone knowing what became of the composer and its text.
Which remedy fits -- kill the composer with its transcript after putting its text on the kill ring as `agentpane-close-session` does for a draft, say in the composer's error that its transcript is gone, or rebind it -- is open.

Done when an ERT test in `emacs/agentpane-test.el` opens a composer with `agentpane-prompt`, types into it, kills its transcript, and asserts the chosen outcome, red before the change and green after.

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) found OW-futuve to be this card's state from another side: a composer left behind by its transcript's death also holds the composer name a later transcript's composer wants, which is why that one comes up as `<2>`.
OW-futuve closed `--moot` as folded into this card, and its own body already said the decision here, not the naming, is the work.

The sweep's reading of the owner: the transcript's buffer-local `kill-buffer-hook`, set up in `agentpane-transcript-mode` and today only `agentpane--detach` and `agentpane--forget-turn-done`, is the one place that knows the transcript is going, and `agentpane--absorb` is the only code that hands a composer over.
Its proposal is that the kill hook owns the composer: kill it with its text on the kill ring, as `agentpane-close-session` does for a draft, except where `agentpane--absorb` has handed it over.
That is a proposal, not a decision; the remedies listed above stay open.

Done also requires OW-futuve's test: kill a transcript with a composer open, open a new transcript in the same project and its composer, and assert the new composer's name carries no `<N>` of its own.

Amended 2026-09-29 by OW-vugefa's close: a preview answered `gone` now kills its transcript through `agentpane--gone` in `emacs/agentpane.el`, which puts only the prompt region's text and an edit's draft on the kill ring, so `g` and a picker row now reach this state as well as `agentpane-close-session`.

## Close note

Chose the remedy the 2026-09-29 sweep proposed: the transcript's kill owns its composers.
`agentpane--kill-composers`, added to the transcript's buffer-local `kill-buffer-hook` in `agentpane-transcript-mode`, kills every buffer whose `agentpane--composer-transcript` is the transcript going, putting any non-empty text on the kill ring first and saying so in the echo area; it binds `kill-buffer-quit-windows` so the window `agentpane-prompt` made goes too, as `agentpane-composer-discard` quits its own.
Ownership is read from the composer's back-pointer, not a flag: `agentpane--absorb` now repoints every composer sending to the buffer it merges away, not only that buffer's own, so a merge hands them over live, a chained merge included (the adversarial read found the secondary composer of an earlier merge dying at the next one).
`agentpane--gone` runs the function before pushing its own texts, so `yank` still brings back the draft and the composer's text sits one `yank-pop` beyond them.
Kill rather than a better error or rebinding because OW-futuve's folded-in done-condition needs the composer's name freed, which only the kill gives.
Verified by five ERT tests in `emacs/agentpane-test.el` -- `agentpane-test-transcript-kill-takes-its-composer` (text and empty, and the window count back to before `agentpane-prompt`), `agentpane-test-composer-name-free-after-its-transcript-dies` (OW-futuve's), `agentpane-test-close-session-whose-preview-is-gone-kills-the-composer-keeping-its-text`, `agentpane-test-merged-transcript-kill-takes-both-composers`, and `agentpane-test-chained-merge-carries-a-secondary-composer` -- each red with the fix stubbed out and green after; full suite 231 run, 0 unexpected, 3 skipped (interactive-only).
Accepted and left: a composer whose send is in flight when its transcript dies puts the sent text on the kill ring too, as the prompt region already does on the `gone` path; and a transcript switched to another major mode by hand still strands its composer while it lives, which predates this card and only `M-x` reaches.
