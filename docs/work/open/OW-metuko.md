---
labels: [change, emacs]
blocked-by: [OW-nufafi]
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
