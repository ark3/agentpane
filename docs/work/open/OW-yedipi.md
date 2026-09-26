---
labels: [change, emacs]
---

# agentpane-mode does not warn that a prompt opening with / is sent as text, not run as a slash command (OW-73)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser shows a warning line under the composer while the draft starts with `/`, because agentpane sends it to the agent as text and no backend runs it as a command: `looksLikeSlashCommand` in `src/client/App.svelte` (closed OW-73).
`agentpane-mode`'s composer in `emacs/agentpane.el` shows nothing.

No wire is needed.
The browser's behaviour is pinned by the three OW-73 tests in `src/client/App.test.ts`.

Done when ERT tests in `emacs/agentpane-test.el` mirroring those three go red before the change and green after.
