---
labels: [change, emacs]
blocked-by: [OW-jamaha]
closed: done
---

# agentpane-mode offers no command to rename an attached session, and its picker shows the preview where a session has a name (D27)

`emacs/agentpane.el` (`agentpane-set-model` as the sibling command, `agentpane--session-entry`, and the `tabulated-list-format` of `agentpane-sessions-mode`), `emacs/agentpane-test.el`.

The Emacs half of renaming, under `docs/DESIGN.md` D27 and the "Names are not marks" paragraph of D13.
OW-jamaha puts `sessions/setName` on the helper's JSON-RPC and `name` on `SessionSummary`; this card is the command and the picker's label.
Its browser twin is filed beside it, blocked by the same card, per `AGENTS.md`, "Both clients".

## What has to exist

- A command in the transcript buffer that reads a name and sends `sessions/setName`, refusing with a message when the buffer is not attached or a turn is running, as the browser offers no control then.
  Its sibling `agentpane-set-model` attaches a detached buffer first (`agentpane--attached-then`); this one refuses instead, because D13 confines renaming to an attached session.
  agentpane-mode has no menu, and its session commands are `M-x` commands; whether this one also gets a key is incidental.
- The picker's Preview column becomes a Session column under D27's rule: the name, then the preview, then the first user text (`agentpane--first-user-text`), and empty after that because the Backend column already says it.
  `agentpane--session-entry`'s docstring says so, and that it mirrors the browser's `sessionLabel`.
  The existing test that finds the column by the name "Preview" (`seq-position` over `tabulated-list-format` in `emacs/agentpane-test.el`) moves to the new name.

Load-bearing: no rename on a detached buffer or mid-turn, and the label order.

## Done when

Each watched red first, in `emacs/agentpane-test.el`:

1. The command on an attached idle buffer sends `sessions/setName` with the session and the name read; on a detached buffer, and on one whose turn is running, it sends nothing.
2. A picker row whose summary carries `:name` shows the name in the Session column, and one with a null name shows the preview.

Run the suite as the commentary at the head of `emacs/agentpane-test.el` gives it: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Landed as 3ed24a5 and ba024fd on main.
`M-x agentpane-rename-session` reads a name and sends `sessions/setName`; `agentpane--check-renamable` refuses it, before the name is read and again before sending, on a buffer not attached (never attaching it), streaming, compacting, with a prompt or fork in flight, or closing -- the browser's `renamable`, with Emacs's fork and close flags standing for the browser's `view.sending` and every sibling's close refusal.
A name blank once trimmed sends nothing; nothing is pre-filled, since the buffer's summary is the one it was last opened from and a rename from the buffer leaves it behind.
The picker's Preview column is now Session: name, then stored preview, then first user text, then empty, as `sessionLabel` orders them.
Each gate clause, the blank check and the label order watched red by mutation; ert 250 tests, 247 as expected, 0 unexpected, 3 skipped.
OW-kametu amended so its route-following gate change covers the Emacs gate too.
