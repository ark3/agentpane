---
labels: [change, emacs]
---

# agentpane-mode does not tell a user that a turn they submitted finished while they were elsewhere, as the browser's favicon badge does (OW-diyuwu)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser badges its favicon when a turn the user submitted ends while the tab is unfocused, and clears the badge on focus: `watchSubmit`, `watchSessions`, `watchFocus` and `setFaviconBadge` in `src/client/favicon.ts` (closed OW-diyuwu, and D17 on its arming moving to a fork's handle).
`emacs/agentpane.el` has nothing: a turn ending in a buffer not shown says nothing.

The wire is enough.
Only an attached session can be submitted to, and every attached buffer already hears its `session/status`.

The Emacs form -- a mode-line indicator, a message, a notification -- is this card's to choose.
What is load-bearing is the watch's semantics: only a turn this Emacs submitted arms it, not one it merely watched, and seeing the session disarms it.

The browser's behaviour is pinned by the "the turn-done watch" block in `src/client/favicon.test.ts`.

Done when ERT tests in `emacs/agentpane-test.el` go red before the change and green after.
One sees the indicator raised when a submitted turn ends in a buffer not shown, and cleared on showing it, and one sees no indicator for a turn this Emacs did not submit.
