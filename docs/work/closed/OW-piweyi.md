---
labels: [defect, emacs]
closed: done
---

# agentpane-mode re-checks a finished-turn mark as seen only at the call sites that remembered to, so a frame brought forward keeps its mark and a tty child frame earns a false one

Found by the adversarial read of OW-yufahi on 2026-09-26, after commits deb733a and c61a024 moved the Emacs picker's finished-turn marks to one global owner.
This is the sibling the rule in `AGENTS.md` ("Evidence", the paragraph beginning "A race fix that adds a guard at the site") asks for: OW-yufahi's re-check of "seen" is a guard at each site, the reader named cases it misses, and the fix is to give that re-check one owner, not to add another call.

## Where the re-check lives now

All in `emacs/agentpane.el`.
`agentpane--clear-seen-turns` drops each mark whose session `agentpane--seen-p` now finds on screen.
It runs from three places, each a guard at its site: the buffer-local `window-buffer-change-functions` hook the transcript mode adds (`add-hook 'window-buffer-change-functions #'agentpane--clear-seen-turns nil t`), `agentpane--on-notification` after it binds `agentpane--handle` and calls `agentpane--hold-ref`, and `agentpane--attached-as`.
`agentpane--seen-p` counts a window only when `tty-top-frame` of its frame is nil or that frame itself.
The `agentpane--clear-seen-turns` docstring declines the frame-brought-forward case as "late in going, not wrong".

## Cases the guards miss

1. Raising a background tty frame (`C-x 5 o`, or `select-frame-set-input-focus`) changes no window's buffer, so the mark for a session shown only there stays until the next listing.
   Reproduced by the reader under `emacs -nw` in a pty, Emacs 31.1, 2026-09-26: the raise ran `window-selection-change-functions` and `window-state-change-functions` but not `window-buffer-change-functions`.
   So the docstring's decline is a choice, not a limit Emacs imposes.
2. Restoring an iconified GUI frame, the same shape as case 1; inferred, not measured, because the home server has no GUI.
3. A transcript in a visible tty child frame (Emacs 31) reads as unseen, because `tty-top-frame` of a child frame names its parent, so `agentpane--seen-p` gives a false mark for a turn the user watched end there.
   Reproduced by the reader.
4. Any new code that writes `agentpane--handle` or `agentpane--session` in a transcript buffer must remember to call `agentpane--clear-seen-turns`, or it reopens OW-yufahi's case 3; nothing makes that call the only way to bind them.

## Intent

One owner for when "seen" is re-checked, retiring the scattered calls it replaces by name.
The reader's suggestion was one global window-state hook, covering buffer changes and frame raises alike, plus one setter that owns a transcript buffer's handle and ref and re-checks as it binds them; that is a lead, not a prescription.
A global hook runs on every window or frame change, so its cost with no marks outstanding should stay near zero; OW-yufahi's implementer declined one on that ground without measuring.
The frame test in `agentpane--seen-p` should read a tty child frame as seen when its root frame is on top.

## Done when

ERT tests in `emacs/agentpane-test.el` for cases 1 and 3 fail against c61a024 and pass after the change; batch Emacs has no text terminal, so a test may fake `tty-top-frame` and run the chosen hook, as `agentpane-test-picker-marks-a-turn-shown-only-in-a-background-tty-frame` fakes the first.
`agentpane-test-picker-mark-cleared-when-a-shown-buffer-becomes-its-session` and the rest of the picker tests still pass.
The `agentpane--clear-seen-turns` docstring no longer declines case 1, and names what the new owner still leaves, case 2 included, with the reason.
Nothing outside the new owner calls `agentpane--clear-seen-turns`; the calls in `agentpane--on-notification` and `agentpane--attached-as`, and the buffer-local hook, are gone, so case 4 is closed by construction rather than by a call each future site must remember.

## Close note

Landed on main as 2882af8 and 3b041ea (emacs/ only; `bun run check` not needed, no src/ touched).
`agentpane--clear-seen-turns` now has one caller, the global `window-state-change-functions`, which `agentpane-sessions-mode` installs and never removes.
It covers a window changing buffer, a tty frame raised by `C-x 5 o` or `select-frame-set-input-focus` (case 1, measured under `emacs -nw` on Emacs 31.1, 2026-09-27), and, through `agentpane--binding-changed`, a variable watcher on `agentpane--handle` and `agentpane--session`, any write to either in a buffer on screen: the watcher sets the frame's window-state-change flag, and the next redisplay runs the hook.
That closes case 4 by construction: the buffer-local hook and the calls in `agentpane--on-notification` and `agentpane--attached-as` are gone, and no site has a call to remember.
`agentpane--seen-p` compares `tty-top-frame` with `frame-root-frame`, so a tty child frame of the top frame reads as seen (case 3).
The `agentpane--clear-seen-turns` docstring names what is still left: a tty child frame shown again by `make-frame-visible` (measured: it runs no window hook) and an iconified GUI frame restored without being selected (case 2, inferred from the tty measurement).
Tests: `agentpane-test-picker-mark-cleared-when-its-tty-frame-is-raised` and `agentpane-test-picker-does-not-mark-a-turn-shown-in-a-tty-child-frame` both failed against dd99b1f's agentpane.el and pass now; `agentpane-test-picker-mark-cleared-when-a-shown-buffer-becomes-its-session` fails with the two `add-variable-watcher` lines removed and passes with them.
Suite: "Ran 137 tests, 134 results as expected, 0 unexpected, 3 skipped"; the tty-tagged run passes 3 of 3.
The adversarial read's cost finding with marks outstanding (about 330 µs per window change with 5 marks at 120 buffers) went into OW-wazipa, which already held the never-dropped marks.
