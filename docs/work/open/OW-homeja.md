---
labels: [change]
---

# The browser's session list sorts by recency only, where agentpane-mode's picker sorts by its Backend, Status or Updated column

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`sortedSummaries` in `src/client/App.svelte` orders the sidebar by `recency` alone, with no other order offered.
`agentpane-sessions-mode` in `emacs/agentpane.el` marks its Backend, Status and Updated columns sortable in `tabulated-list-format`, so a user can sort the picker by any of them.
This is the smallest gap the survey found.

No wire is needed.

Done when a test in `src/client/App.test.ts` chooses an order other than recency and finds the rows in that order, red before the change and green after.
