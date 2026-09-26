---
labels: [change, emacs]
---

# agentpane-mode's picker filters to the calling buffer's project or to nothing, where the browser's Workspace select filters to any workspace seen

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's Workspace select offers every cwd among the listed sessions and narrows the sidebar to the chosen one: `workspaceOptions` and `filteredSummaries` in `src/client/App.svelte`.
`agentpane-sessions` in `emacs/agentpane.el` lists the calling buffer's project (`agentpane--current-cwd`), or every session under a prefix argument, and nothing in between.

The wire is enough: `sessions/list` takes `{ cwd }`.
The browser's behaviour is pinned by `src/client/App.test.ts` "re-selects the most recent session in scope when the workspace filter changes".
How the choice is offered -- completion over the listed cwds, for instance -- is this card's to decide.

Done when an ERT test in `emacs/agentpane-test.el`, stubbing the request as `agentpane-test--new-session` does (`emacs/fake-helper.ts` records no params and ignores `cwd`), chooses a workspace other than the calling buffer's and sees `sessions/list` sent with that `cwd`, red before the change and green after.
