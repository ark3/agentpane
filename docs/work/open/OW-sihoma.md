---
labels: [deferral, emacs]
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
