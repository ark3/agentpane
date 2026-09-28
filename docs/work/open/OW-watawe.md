---
labels: [defect, emacs]
---

# agentpane-close-session kills a buffer with nothing on disk without a word, discarding its draft, where the browser keeps its draft across a Detach to the startup view

Found by the adversarial read of OW-yosege on 2026-09-27.

`agentpane-close-session` in `emacs/agentpane.el`, on a session the post-close `sessions/list` says is not `onDisk` (a virtual session, or a fork before its first turn), kills its transcript buffer, as the browser's `controller.detach` in `src/client/controller.ts` clears the selection to the startup view (OW-vasubu).
The kill discards whatever the user had typed in the buffer's prompt region, and leaves a composer buffer, if `agentpane-prompt` made one, pointing at a dead transcript.
The browser's single `view.draft` survives that same Detach.
The composer orphaning is what any manual kill of a transcript does too; the lost draft is what this command added.

What is in service of: a user who closes a never-prompted session loses nothing they typed.
Which remedy fits — keep the buffer as an empty unattached one, carry the draft somewhere, or ask before killing when a draft is non-empty — is this card's to decide, and the choice goes in the command's docstring.

Done when an ERT test in `emacs/agentpane-test.el`, built on the `agentpane-test--closing` macro, types a draft into the prompt region, closes a session the listing reports not on disk, and asserts the draft survives by whatever route the chosen remedy provides, red before the change and green after.
