---
labels: [defect, emacs]
blocked-by: [OW-kihisa]
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
