---
labels: [defect, emacs, emacs-native]
closed: done
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

## Why two of the undo items get no test (2026-09-22, at the close)

- `(apply DELTA BEG END FUN . ARGS)`: as of Emacs 31.1 the only producer the prompt region can reach is `combine-change-calls` (subr.el), through `comment-region` and `uncomment-region` (newcomment.el), and `agentpane-transcript-mode` defines no comment syntax, so `M-;` there first prompts for one; cua-mode's rectangle commands (cua-rect.el) push them too.
  Shifting BEG and END would not be enough anyway: `combine-change-calls` puts a nested undo list of absolute positions in ARGS (`undo--wrap-and-run-primitive-undo BEG END LIST`), a function-specific payload the shift cannot read in general.
- A redraw that signals partway: that happens only for a node breaking the contract in `src/emacs/protocol.ts`, and a `C-g` cannot land in one, since in Emacs 31.1 jsonrpc.el delivers every notification and async reply from a timer (`timer-create` in `jsonrpc--process-filter`) and Emacs binds `inhibit-quit` around timer functions (elisp manual, "Timers"); the only synchronous callers draw an empty node list (`agentpane-new-session` and the fork path).
  Were a helper bug to break the contract, the transcript would be half drawn and the draft's undo entries left stale, so a later undo could edit node text.

## Done when

An ert test in `emacs/agentpane-test.el` shows a window's `window-start` survives a `session/snapshot` delivered through `agentpane--on-notification` (a window can be made in batch with `set-window-buffer` on the selected window), failing before the fix.
The composer's name follows a rename, or a sentence in `agentpane-prompt`'s docstring says why it need not.

## Close note

Landed on main as c2e6090, d379fef and a4890f6, in `emacs/agentpane.el` and `emacs/agentpane-test.el`.

- `agentpane--keeping-points` now keeps each window's start as well as its point: a window following the tail (point in the prompt region) keeps its start the same distance from the end, any other keeps its start's position, set with NOFORCE so redisplay may still choose another start rather than move point.
- The composer's name follows the transcript: `agentpane--rekey` renames a live composer through `agentpane--composer-name`, which `agentpane-prompt` also uses.
- Undo in region: `agentpane--above-prompt` now also shifts `pending-undo-list` while an undo-in-region run is the last command in this buffer; a probe showed the stale copy editing read-only node text, since undo inhibits read-only.
- The other two undo items are answered by sentences in this card's body, "Why two of the undo items get no test".

Verified by ert, 35/35 on Emacs 31.1; `agentpane-test-snapshot-keeps-window-start` was red with a start of 1 against 137, `agentpane-test-renamed-renames-the-composer` red with the old composer name, `agentpane-test-undo-in-region-survives-a-redraw` red with node text edited, and `agentpane-test-redraw-leaves-another-buffers-undo-alone` red when its buffer check was removed.
The jump itself was only ever reasoned, since batch Emacs does no redisplay; the fix is shown by `window-start` values, and a look in a real frame (attached, scrolled to the tail, then `g`) would close that.
