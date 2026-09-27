---
labels: [change, emacs]
blocked-by: [OW-nufafi]
closed: done
---

# agentpane-mode's picker has no finished-turn marker for a session whose turn ended while the user was looking at another

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser marks a live sidebar row with the `.session-finished` dot when its turn ended while another session was selected, and keeps it until that session is selected: `foldSessionTurns` in `src/client/session-turns.ts`, drawn in `src/client/App.svelte`.
`agentpane-sessions-mode` in `emacs/agentpane.el` has no such column or mark.

It is blocked by OW-nufafi, which opens the helper's event stream before anything attaches.
From then on a turn's start and end each broadcast `sessions/changed` (`#onUpdate` in `src/server/http/session-manager.ts`, OW-furinu), and the re-list that follows carries each session's live `isStreaming`, so the picker sees every transition, attached or not.
A marker fed by those re-lists can miss a turn so short that both re-lists read it as not streaming; the browser's, fed by live status, does not.
Whether that miss matters is this card's to judge and to state.
What "selected" maps to in Emacs -- a buffer shown in the selected window, or shown at all -- is this card's to decide and to state in the docstring.

The browser's behaviour is pinned by `src/client/session-turns.test.ts` and by `src/client/App.test.ts` "retains a finished-turn marker on an unselected session until it becomes selected".

Done when an ERT test in `emacs/agentpane-test.el` sees the marker appear on a row whose turn ended while its buffer was not selected, survive a re-list, and clear once it is selected, red before the change and green after.

## Close note

Landed in 0929e34: the Emacs picker (`agentpane-sessions-mode`, `emacs/agentpane.el`) now marks a row with a red dot, the `agentpane-turn-finished` face in the browser's `--ap-turn-finished` colours, when a listing reads the session not streaming after one read it streaming and no window shows its transcript.
The state is kept by handle in `agentpane--listed-streaming` and `agentpane--finished-turns`, folded by `agentpane--note-turns` from each `sessions/list` reply, so the mark survives the rebuilt rows; handle rather than ref so a Pi rename between the two listings does not lose the turn.
"Selected" maps to a transcript buffer holding the session, by handle or ref, shown in any window of a visible frame (`agentpane--seen-p`), not only the selected window, because the picker beside a transcript is the ordinary layout; the browser's "no selection marks nothing" has no counterpart, and the docstring says why.
The mark clears at a listing and at once through a buffer-local `window-buffer-change-functions` hook, `agentpane--clear-seen-turns`, confirmed to run under redisplay in a tty `emacs -nw -Q` on Emacs 31.1.
A turn shorter than one `sessions/list` round trip is not marked, where the browser marks it; judged acceptable in `agentpane--note-turns`'s docstring as a turn that failed or was aborted as it began.
Verified by the ERT test `agentpane-test-picker-marks-a-turn-that-finished-unseen`, which failed against the unchanged file at the first mark assertion; each other assertion was seen red under a mutation. Full ERT suite 129 run, 126 as expected, 3 skipped; `bun run check` green.
The adversarial read found the marks are owned by one picker's cwd-filtered listing and cleared against its rows, so a filter change can leave a stale mark or add a wrong one; filed as the ownership sibling OW-yufahi with the other cases it named.
