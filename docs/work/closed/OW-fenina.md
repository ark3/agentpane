---
labels: [change, emacs]
closed: done
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

## Close note

Landed in 18e1ae5 and 4a535fb.
`w` in the Emacs picker (`agentpane-sessions-workspace` in `emacs/agentpane.el`) offers, through `completing-read`, "All workspaces" and then every cwd in the picker's last listing, ordered as the browser's `workspaceOptions` orders them: most recently updated first, by `updatedAt`, else `createdAt`, parsed to the millisecond.
Choosing one sets `agentpane--cwd` through `agentpane--filter-picker`, the helper `agentpane-sessions` now shares, and refetches.
`sessions/list` is still sent with no params.
The unfiltered listing is kept in the buffer-local `agentpane--listing`, because `tabulated-list-entries` holds only the rows the filter keeps.

Verified by the ERT test `agentpane-test-picker-chooses-another-workspace` in `emacs/agentpane-test.el`.
It lists sessions in two workspaces, chooses the one that is not the calling buffer's, and asserts that the rows narrow to it and that both `sessions/list` calls carried nil params.
Against main's `agentpane.el` it failed with `void-function agentpane--workspaces`, and with the command applying no filter it failed on the rows.
The adversarial reader found that the first fixture also passed with the order reversed, and that `iso8601-parse` without its second argument dropped the milliseconds the browser's `Date.parse` keeps.
Both were fixed in 4a535fb, and the new fixture fails under reversed order, no sort, and dropped fractions, each at the workspace-order assertion.
The full suite ran 151 tests, 148 passed and 3 skipped.
Nothing under `src/` changed.

Left as is: the interactive completion path (the "All workspaces" to nil mapping, and an empty answer) has no ERT test, though the reader drove it by hand in batch.
The chosen workspace lasts until `agentpane-sessions` runs again, which, as before, filters the picker to the calling buffer's project.
