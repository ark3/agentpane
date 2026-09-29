---
labels: [deferral, emacs, sweep-0929]
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
