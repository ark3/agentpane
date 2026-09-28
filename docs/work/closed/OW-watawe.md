---
labels: [defect, emacs]
closed: done
---

# agentpane-close-session kills a buffer with nothing on disk without a word, discarding its draft, where the browser keeps its draft across a Detach to the startup view

Found by the adversarial read of OW-yosege on 2026-09-27.

`agentpane-close-session` in `emacs/agentpane.el`, on a session the post-close `sessions/list` says is not `onDisk` (a virtual session, or a fork before its first turn), kills its transcript buffer, as the browser's `controller.detach` in `src/client/controller.ts` clears the selection to the startup view (OW-vasubu).
The kill discards whatever the user had typed in the buffer's prompt region, and leaves a composer buffer, if `agentpane-prompt` made one, pointing at a dead transcript.
The browser's single `view.draft` survives that same Detach.
The composer orphaning is what any manual kill of a transcript does too; the lost draft is what this command added.

The adversarial read of OW-dakeyi on 2026-09-28 named a second thing the same kill discards, read and not run.
OW-dakeyi's `agentpane--closing` refuses every send while the close is out, but clears when the close answers, before the `sessions/list` request goes out; a `C-RET` in the gap between the close answering and the listing answering attaches and prompts, and a listing reporting the session not on disk then kills the buffer with that prompt in flight.
Whatever the remedy chosen here, it covers that prompt as well as the draft, or the close state is held until the listing has answered.

What is in service of: a user who closes a never-prompted session loses nothing they typed.
Which remedy fits — keep the buffer as an empty unattached one, carry the draft somewhere, or ask before killing when a draft is non-empty — is this card's to decide, and the choice goes in the command's docstring.

Done when an ERT test in `emacs/agentpane-test.el`, built on the `agentpane-test--closing` macro, types a draft into the prompt region, closes a session the listing reports not on disk, and asserts the draft survives by whatever route the chosen remedy provides, red before the change and green after.

## Close note

Landed on main as bc09a13 (2026-09-28).
`agentpane-close-session` in `emacs/agentpane.el` now holds `agentpane--closing` until the post-close `sessions/list` answers or fails, rather than clearing it when the close answers, so no send, attach, fork or `g` goes out in the gap; it is cleared before either branch acts, since the on-disk branch's `agentpane-refetch` reads it.
On the not-on-disk branch the prompt region's text goes on the kill ring before the kill, and under an edit the displaced draft too, pushed last so `yank` brings the draft back and `yank-pop` the edit; the echo area says so.
Remedy chosen: the kill ring, following `agentpane--absorb` (OW-bifevo); keeping the buffer would leave a send that attaches a ref the server no longer holds (OW-vasubu), and asking would prompt from inside the listing's callback. Recorded in the command's docstring.

Correction to the card: a send in the old gap did not run a turn. For a session with nothing on disk `SessionManager.attach` in `src/server/http/session-manager.ts` answers `UnknownSessionError` once `close` has run, so the only loss was the unsent text; the docstrings and commit say so.

Verified: four new ERT tests on `agentpane-test--closing` (keeps-the-draft, keeps-an-edit, listing-out-reaches-nothing, listing-that-fails-frees-the-buffer); the first three red against the pre-fix code, the fourth red against a variant with no listing failure path; a reader's mutation run turned each targeted test red. Full ERT green (198 run, 3 skipped as before), `bun run check` green.

Filed from the adversarial read: OW-vetebu (a failed listing leaves a never-prompted buffer standing) and OW-sihoma (a composer outlives its transcript); the merge-during-close case amended into OW-larele. Whitespace-only drafts still go on the kill ring, as in `agentpane--absorb`; left.
