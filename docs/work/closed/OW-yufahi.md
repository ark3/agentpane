---
labels: [defect, emacs]
closed: done
---

# agentpane-mode's finished-turn marks belong to one picker's filtered listing, so a filter change leaves a mark the user already cleared or adds one for a turn they watched end

Found by the adversarial read of OW-metuko on 2026-09-26, after that card landed the Emacs picker's finished-turn mark in commit 0929e34.
This is the ownership change the sibling rule in `AGENTS.md` ("Evidence", the paragraph beginning "A race fix that adds a guard at the site") asks for: the state has the wrong owner, and a second guard is not the fix.

## Where the state lives now

`agentpane--listed-streaming` and `agentpane--finished-turns` in `emacs/agentpane.el` are buffer-local to the `*agentpane sessions*` picker, created by `agentpane-sessions-mode`, and keyed by handle.
They are fed only by `agentpane--note-turns`, which reads the picker's own `sessions/list` reply, filtered by `agentpane--cwd`.
They are cleared by `agentpane--note-turns` at each listing and by `agentpane--clear-seen-turns`, a buffer-local `window-buffer-change-functions` hook in each transcript buffer, which walks only the rows in `tabulated-list-entries`.
The browser's counterpart, `foldSessionTurns` in `src/client/session-turns.ts`, folds over every live session in its state whatever the sidebar's filter.

## Cases the current guard misses

Each was reproduced by the reader as a scratch ERT test against 0929e34, except the last, which is inferred.

1. A marked session stops being a row after `agentpane-sessions` is re-run for another project, which reuses the buffer and keeps its tables because the mode does not re-run.
   The user then views that session's transcript: the hook runs, but the session is not a row, so nothing clears.
   Listing its project again shows the mark.
2. A session is listed streaming, the filter changes, and its turn ends while its transcript is on screen.
   Listing its project again after the user looks away reads it as not streaming after streaming and marks it, though the user watched the turn end.
3. A transcript buffer becomes the marked session while already on screen: `agentpane--attached-as` or a notification binds the handle, or `agentpane--hold-ref` moves the ref, and no window changes buffer.
   The hook does not run, so the mark stays until the next listing.
4. On a text terminal, `get-buffer-window` with `'visible`, which `agentpane--seen-p` uses, finds a transcript in a background tty frame, and `frame-visible-p` answered t for a frame not being looked at (Emacs 31.1, measured by the reader).
   A turn ending in a `C-x 5 2` frame the user is not looking at is therefore never marked.
5. Inferred, not measured, because the home server has no GUI: making an iconified GUI frame visible again changes no window's buffer, so a mark for a session shown in that frame should stay until the next listing.

The implementer also noted two things this card should rule on, each either done here or stated as declined in the docstring:
- the browser moves a mark from a fork's parent to the fork (`moveSessionTurnMarks`), and Emacs does not;
- a visible composer buffer without its transcript does not count as seen.

## Intent

Put the marks where "a turn ended" and "the user has seen it" live: one owner for every live session the helper reports, not one per picker view.
Clear against every marked handle rather than against the picker's rows.
Case 2 needs a streaming level observed for sessions outside the filter; how to get it, whether from an unfiltered listing or from something already on the helper's wire in `src/emacs/protocol.ts`, is this card's to choose.
The re-list miss for turns shorter than one `sessions/list` round trip was judged acceptable in `agentpane--note-turns`'s docstring; this card need not reopen it.
Cases 3 to 5 are about when "seen" is re-checked; name in the docstring which of them the new owner covers and why any it leaves are acceptable.

## Done when

An ERT test in `emacs/agentpane-test.el` for each of cases 1, 2 and 3 fails against 0929e34 and passes after the change, and `agentpane-test-picker-marks-a-turn-that-finished-unseen` still passes.
Cases 4 and 5, the fork mark and the composer each either have a test of their own or are named as declined, with the reason, in the owning docstring.

## Close note

Landed in deb733a and c61a024 on main.
The picker's finished-turn marks and streaming levels are now one global table each in `emacs/agentpane.el`, keyed by handle, with each mark holding its session's latest summary so `agentpane--seen-p` can match by ref too.
Case 2's levels come from an unfiltered `sessions/list`: the picker filters rows itself by exact cwd, as the browser's sidebar does (`filteredSummaries` in `src/client/App.svelte`); nothing changed on the wire.
`agentpane--clear-seen-turns` walks every mark (case 1) and also runs from `agentpane--on-notification` and `agentpane--attached-as` (case 3).
`agentpane--seen-p` counts a tty window only on its terminal's top frame (case 4, measured under `emacs -nw` in a pty, Emacs 31.1).
A new picker clears the levels, not the marks.
Declined in docstrings with reasons: case 5 (`agentpane--clear-seen-turns`), the fork mark (`agentpane--note-turns`, which also says the fork takes the parent's window so a still-running parent turn ends unseen and marks the parent), and the composer (`agentpane--seen-p`).
Verified: tests for cases 1, 2, 3 and 4 fail against 72506b5's `agentpane.el` and pass; `agentpane-test-picker-lists-only-its-projects-sessions` fails with the client-side filter made a no-op; `agentpane-test-picker-marks-a-turn-that-finished-unseen` still passes; the full ERT suite has 135 tests with 0 unexpected and 3 skipped.
The adversarial read found that case 3's fix is a guard at each site that misses a frame brought forward and tty child frames; per the sibling rule, OW-piweyi carries the ownership change.
Its remaining nits (tables never pruned, the `clrhash` against a second picker, the unfiltered reply's size) are OW-wazipa.
