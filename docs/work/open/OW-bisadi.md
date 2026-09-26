---
labels: [change, emacs]
---

# agentpane-mode's picker shows no workspace column, so its C-u all-sessions view cannot tell one project's sessions from another's

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

Each browser sidebar row shows the session's workspace as a basename, with the full path as its tooltip: the `.session-cwd` span in `src/client/App.svelte`.
The picker's `tabulated-list-format` in `agentpane-sessions-mode` (`emacs/agentpane.el`) has Backend, Status, a dot, Updated and Preview, and no workspace.
That matters in the unfiltered view `agentpane-sessions` gives under a prefix argument.

The wire is enough: `SessionSummary.cwd` is on every listed summary.
The browser's behaviour is pinned by `src/client/App.test.ts` "shows each session's backend, its workspace, and a second-precision timestamp" and "shows the workspace basename rather than the full cwd".

Done when an ERT test in `emacs/agentpane-test.el` lists two sessions in different workspaces and finds each row carrying its workspace's basename, red before the change and green after.
