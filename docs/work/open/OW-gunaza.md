---
labels: [defect, emacs, emacs-native]
---

# A session/snapshot resets the transcript window start to the top, so a window following the tail jumps

Found 2026-09-22 by the adversarial read of OW-gunuke's change.

`agentpane--draw` in `emacs/agentpane.el` deletes from `point-min` to the prompt separator before redrawing, which collapses every window's start marker to 1; `agentpane--keeping-points` restores each window's point but not its start.
Probe in `emacs --batch` (Emacs 31.1): window start 1616 before a snapshot, 1 after, point correctly still at the end.
The visual effect is reasoned, since batch does no redisplay: redisplay has to scroll back to the point, and with default scroll settings it recentres, so the view jumps.
Snapshots are rare — attach, `g` on an attached buffer, and the helper's resync after a missed event — so it is a jump, not a continuous jitter.

Also cosmetic and found at the same time: the composer buffer is named from its transcript buffer's name when `agentpane-prompt` creates it, and does not follow `agentpane--rekey` renaming the transcript.

Also low, from the read of cd6c245's predecessor, in `agentpane--above-prompt` in `emacs/agentpane.el`: an `(apply DELTA BEG END FUN . ARGS)` undo entry is not shifted, though nothing in the prompt region makes one today; undo with the region active builds its own `pending-undo-list` copy, which the shift does not reach; and a redraw that signals partway through changes the size without shifting.
Each needs a test that fails before it is fixed, or a sentence here saying why it is not worth one.

## Done when

An ert test in `emacs/agentpane-test.el` shows a window's `window-start` survives a `session/snapshot` delivered through `agentpane--on-notification` (a window can be made in batch with `set-window-buffer` on the selected window), failing before the fix.
The composer's name follows a rename, or a sentence in `agentpane-prompt`'s docstring says why it need not.
