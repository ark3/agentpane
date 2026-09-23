---
labels: [defect, emacs, emacs-native]
---

# A transcript buffer re-keyed onto a ref another buffer already holds leaves two buffers for one session, and killing either now detaches both

Filed 2026-09-22 from the adversarial read of OW-nuwive; reasoned from `emacs/agentpane.el`, not reproduced.
In service of one transcript buffer per session, which `agentpane--transcript-buffer`'s docstring promises ("One buffer per session ref") and the rest of the mode assumes.

`agentpane--transcript-buffer` reuses a buffer by ref through `agentpane--buffer-for`, but `agentpane--rekey` — run by `session/renamed` in `agentpane--on-notification` and by the attach reply in `agentpane--attach` — moves a buffer onto a new ref without checking whether another buffer already holds it.
Scenario: a buffer previews a session under a virtual ref; the browser's first prompt renames it; the picker then opens the canonical ref in a second buffer; a send in the first buffer attaches it, and the reply (or the helper's `session/renamed`) re-keys it onto the ref the second holds.
From then on `agentpane--buffer-for` finds whichever comes first in `buffer-list`, so notifications go to one and the other goes stale.
This predates OW-nuwive, but OW-nuwive made it worse: killing either buffer now sends `sessions/detach` for the shared ref (`agentpane--detach`), silencing the survivor, which still counts itself attached until `g`.

Decide what a rekey onto a held ref does — merge into the existing buffer and kill the rekeyed one, or refuse and redraw — and say so in `agentpane--rekey`'s docstring.

## Done when

An ert test in `emacs/agentpane-test.el` makes two transcript buffers, re-keys one onto the other's ref through `agentpane--on-notification` with a `session/renamed`, and asserts exactly one buffer then holds that ref, red before the fix.
