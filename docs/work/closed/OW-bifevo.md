---
labels: [defect, emacs]
blocked-by: [OW-kihisa]
closed: done
---

# A merge that kills a transcript buffer holding an open edit carries the edited text across as a plain draft, so the next C-RET prompts the session instead of forking

Found by the adversarial read of OW-kihisa on 2026-09-27.

`agentpane--absorb` in `emacs/agentpane.el` moves OTHER's prompt-region draft, composer and windows into the surviving buffer and kills OTHER.
OW-kihisa added `agentpane--editing`, a buffer-local plist (index, images, displaced draft, overlay) that `agentpane--send-prompt` routes on; `agentpane--absorb` does not know it exists.
So when the buffer killed is one with an open edit, the survivor receives the loaded message text as an ordinary draft, the images and the displaced draft are gone, and a C-RET there prompts the survivor's session with that text rather than forking at the message.
The reviewer reproduced it by making a second buffer, previewing another name of the same session, attach while the first held an edit; the merge conditions are the ones `agentpane--absorb`'s docstring and closed OW-jafini describe.

What is load-bearing is that no send after a merge silently prompts the session with text the user loaded to fork with.
Carrying the edit into the survivor, dropping it and restoring the displaced draft, or refusing the merge's draft move are all open; pick the smallest that holds, and note that the survivor may have an edit of its own.

Done when an ERT test in `emacs/agentpane-test.el`, run as that file's Commentary says, goes red before the change and green after: it opens an edit in one buffer, merges it into another through the attach path the existing `agentpane--absorb` tests drive, sends from the survivor, and asserts that no `sessions/prompt` carries the loaded text to the parent session unforked.

## Close note

Landed in three commits on main (d9a725b, d664876, 043bc69), all in `agentpane--absorb` in `emacs/agentpane.el`, whose docstring now documents each rule.

- When OTHER holds an edit, the edit is dropped. What moves to the survivor is the draft that edit displaced, not the loaded message text. OTHER's prompt region, the message plus whatever the user changed in it, goes on the kill ring, and the echo area says so.
- When the survivor holds an edit of its own, OTHER's draft is appended to that edit's `:draft` in place, and the survivor's prompt region is left alone. Cancelling the edit restores both drafts; a successful fork drops both, just as the browser drops a displaced draft unless the edit is cancelled. Without this, an edit sent from a detached survivor, whose attach made the merge, left "<edited text>\n<OTHER's draft>" as a plain draft once the fork answered, and the next C-RET prompted the parent with it unforked. The adversarial read found this case; it existed before the first commit.

Chosen over carrying OTHER's edit across, which would need its own reconciliation whenever the survivor also holds an edit.

Verified with three new ERT tests in `emacs/agentpane-test.el`. Each fails against fa801b8's `agentpane.el` and passes after the fix:
- `agentpane-test-attach-onto-a-held-handle-drops-an-edit`: one `sessions/prompt`, to the parent, carrying only the drafts; the edited text is on the kill ring.
- `agentpane-test-attach-onto-a-held-handle-keeps-the-survivors-edit`
- `agentpane-test-edit-send-that-merges-leaves-no-draft-to-prompt`

`agentpane-test--merging` can now answer `sessions/forkPoints` and `sessions/fork`. Full file: 194 tests, 0 unexpected, 3 skipped. Nothing under `src/` changed.

Left for OW-larele: a `sessions/fork` in flight from OTHER at the merge has its reply dropped with the killed buffer, so no buffer ever opens on the fork.
