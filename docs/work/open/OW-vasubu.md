---
labels: [defect]
---

# Detaching a virtual session strands the selection on an Attach button that can only 404

Found while reviewing OW-tewave, which decided deliberately that Detach is offered for a `virtual` selection and that its row then vanishes from the listing, because `list()` is disk plus the table and a virtual session has nothing on disk.
That much the owner accepted on 2026-09-16.
What that card did not name, and what this one is for, is the state the user is left in.

`readSessionPreview` answers a `virtual:` ref with `[]` rather than an error -- `resolvePiSessionPath` returns null -- so `view.preview` is non-null and `src/client/App.svelte` swaps to the `{#if previewing}` branch, whose whole composer is one Attach button.
Meanwhile the row is gone, so `selectedSummary` is `undefined`, which also disables New through `newSessionWorkspace`.
Pressing that Attach button calls `api.attach` on a ref the session manager no longer holds: `no such session`, a 404 into the error banner.

So the only control on screen is one that can only fail, which is a dead end rather than the accepted cost of a vanishing row.

OW-tewave already names one revisit for the virtual case -- a `Discard` label when the selection is virtual -- and that is a different question; this one is about where the user lands, whatever the label says.

Done when detaching a virtual selection leaves the user somewhere they can act from, asserted in `src/client/App.test.ts` or `src/client/controller.test.ts` and red first.
Clearing the selection outright is the obvious candidate and is not the decided answer.
