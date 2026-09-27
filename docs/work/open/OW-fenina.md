---
labels: [change, emacs]
---

# agentpane-mode's picker filters to the calling buffer's project or to nothing, where the browser's Workspace select filters to any workspace seen

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's Workspace select offers every cwd among the listed sessions and narrows the sidebar to the chosen one: `workspaceOptions` and `filteredSummaries` in `src/client/App.svelte`.
`agentpane-sessions` in `emacs/agentpane.el` lists the calling buffer's project (`agentpane--current-cwd`), or every session under a prefix argument, and nothing in between.

No wire is needed.
Since OW-yufahi the picker asks `sessions/list` for every session and filters rows itself by the buffer-local `agentpane--cwd`, as the browser's sidebar does; the `agentpane--refetch-sessions` docstring says why, and the listing stays unfiltered so `agentpane--note-turns` reads every session's streaming level.
Choosing a workspace is a change to `agentpane--cwd`, not to the request.
The browser's behaviour is pinned by `src/client/App.test.ts` "re-selects the most recent session in scope when the workspace filter changes".
How the choice is offered -- completion over the listed cwds, for instance -- is this card's to decide.

Done when an ERT test in `emacs/agentpane-test.el` lists sessions in two workspaces, chooses one other than the calling buffer's, and finds the picker's rows narrowed to that workspace's sessions, red before the change and green after.
The same test sees `sessions/list` still sent with no `cwd`, so the choice cannot quietly move the filter back onto the wire.
