---
labels: [defect, emacs, emacs-native]
closed: done
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

## Close note

Landed on main as the one OW-jafini commit after e57a5b5 ("fix: merge a transcript buffer rekeyed onto a held ref"), in `emacs/agentpane.el` and `emacs/agentpane-test.el`.

Decision, in `agentpane--rekey`'s docstring: a buffer re-keyed onto a ref another buffer holds survives, and the other is merged into it by `agentpane--absorb` and killed.
The rekeyed buffer survives because it is always the attached one (a forwarded `session/renamed` reaches only attached sessions, and the attach reply and `agentpane--attach-now` rekey on attaching) and because its own attach reply goes on to run its waiters, a queued prompt among them, in it.
The other's prompt-region draft is appended to the survivor's, its composer (with any text) sends to the survivor from then on, windows showing it show the survivor, and its kill has the `agentpane--detach` hook disarmed so the shared session is not silenced.
The other's own in-flight requests are dropped with it, as any killed buffer's are.

Verified by ert, 43/43 on Emacs 31.1: `agentpane-test-renamed-onto-a-held-ref-leaves-one-buffer` was red with two buffers holding the ref, and went red again with the disarm removed (a `sessions/detach` sent) and with the window move removed; `agentpane-test-renamed-onto-a-held-ref-keeps-drafts` was red with the other's draft lost.
The attach-reply path was checked only by an uncommitted script; the committed tests drive `session/renamed`.
Not run live.
The swap happens with no echo-area message, and a composer taken over beside the survivor's own keeps its old name; both left as they are.
