---
labels: [change, emacs]
closed: done
---

# agentpane-mode's picker shows no workspace column, so its C-u all-sessions view cannot tell one project's sessions from another's

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

Each browser sidebar row shows the session's workspace as a basename, with the full path as its tooltip: the `.session-cwd` span in `src/client/App.svelte`.
The picker's `tabulated-list-format` in `agentpane-sessions-mode` (`emacs/agentpane.el`) has Backend, Status, a dot, Updated and Preview, and no workspace.
That matters in the unfiltered view `agentpane-sessions` gives under a prefix argument.

The wire is enough: `SessionSummary.cwd` is on every listed summary.
The browser's behaviour is pinned by `src/client/App.test.ts` "shows each session's backend, its workspace, and a second-precision timestamp" and "shows the workspace basename rather than the full cwd".

Done when an ERT test in `emacs/agentpane-test.el` lists two sessions in different workspaces and finds each row carrying its workspace's basename, red before the change and green after.

## Close note

Landed in 3df9575: `agentpane--session-entry` in `emacs/agentpane.el` draws a new Workspace column, `("Workspace" 16 t)` between Updated and Preview, holding the last segment of `SessionSummary.cwd` (`file-name-nondirectory`, which agrees with the browser's `basename` in `src/client/App.svelte` on trailing slashes) with the full path as `help-echo`, the equivalent of the browser's `title`, and an empty cell where cwd is null, as the browser's `{#if summary.cwd}` draws nothing; jsonrpc.el delivers JSON null as nil, so that branch is reachable.
Verified by `agentpane-test-picker-shows-each-sessions-workspace` in `emacs/agentpane-test.el`, which opens the C-u all-sessions picker over three sessions (in /tmp/one/alpha, /tmp/two/beta, and with no cwd): red against the old `agentpane.el` with the row drawn as `["pi" "attached" "" "" "a"]`, green after, and the whole ERT suite at 150 run, 0 unexpected, 3 skipped.
The adversarial read found no row or format code indexing cells by position, so the new column shifts nothing; it found the test's no-cwd check passed with a cell drawn as "nil" or "-", and review tightened it to read that row's Workspace cell by column name, shown red against a `(format "%s" cwd)` mutant.
Not seen in a running Emacs; the help-echo is covered only by the ERT assertion.
